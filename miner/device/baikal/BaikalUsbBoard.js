const {
        BAIKAL_STATUS_NONCE_READY,
        BAIKAL_STATUS_JOB_EMPTY,
        BAIKAL_STATUS_NEW_MINER,
        toBaikalAlgorithm
    } = require('./constants'),
    {bits192, maximumTarget} = require('../../../stratum/algorithm/constants'),
    bignum = require('bignum'),
    {RingBuffer} = require('../../util/RingBuffer'),
    EventEmitter = require('events');

class BaikalUsbBoard extends EventEmitter {
    constructor(usbInterface, board_id) {
        super();

        this.usbInterface = usbInterface;

        this.board_id = board_id;

        this.id = `BLKU:${usbInterface.getBusNumber()}:${usbInterface.getDeviceAddress()}:${this.board_id}`;

        this.algorithm = null;

        this.usbInterface.on('info', this._handleInfo.bind(this));
        this.usbInterface.on('result', this._handleResult.bind(this));
        this.usbInterface.on('send_work', this._handleSendWork.bind(this));

        this.firmwareVersion = null;
        this.hardwareVersion = null;
        this.clock = null;
        this.asicCount = null;
        this.asicVersion = null;
        this.temperature = null;

        this.ringBuffer = new RingBuffer(255);

        this.target = null;
        this.board_target = null;

        this.difficulty = null;
        this.lastNonceFoundAt = 0;
        this.lastNonceWorkIndex = null;

        this.statsStartedAt = null;
        this.sharesFound = 0;

        this.clearStats();
    }

    getEffectiveHashrate() {
        const secondsElapsed = (Date.now() - this.statsStartedAt) / 1000;
        return (this.algorithm.getEstimatedHashesForShares(this.sharesFound) / secondsElapsed) / 1000 | 0;
    }

    getHashrate() {
        return this.clock * this.asicCount * 500;
    }

    getId() {
        return this.id;
    }

    getHardwareVersion() {
        if(this.hardwareVersion !== this.asicVersion) {
            return `HW: ${this.hardwareVersion} ASIC: ${this.asicVersion}`;

        } else {
            return this.hardwareVersion;
        }
    }

    getFirmwareVersion() {
        return this.firmwareVersion;
    }

    getTemperature() {
        return this.temperature;
    }

    getChipCount() {
        return this.asicCount;
    }

    getChipClock() {
        return this.clock;
    }

    getDifficulty() {
        return this.difficulty;
    }

    getAlgorithm() {
        return this.algorithm;
    }

    clearStats() {
        this.statsStartedAt = Date.now();
        this.sharesFound = 0;
    }

    setAlgorithm(algorithm) {
        this.algorithm = algorithm;
    }

    setTarget(targetBigNum) {
        if(!this.algorithm)
            throw 'No algorithm set, set algorithm first';

        // target is managed in the hashboards with 8 bytes accurancy, so strip away the rest

        this.target = targetBigNum;
        this.difficulty = this.algorithm.getDifficultyForTarget(this.target);

        this.board_target = targetBigNum.div(bits192);
    }

    /**
     * Info Request for the given device
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleInfo(message) {
        if(message.board_id !== this.board_id)
            return;

        this.firmwareVersion = message.fw_ver;
        this.hardwareVersion = message.hw_ver;
        this.clock = message.clock;
        this.asicCount = message.asic_count;
        this.asicVersion = message.asic_ver;
    }

    /**
     * Result request for the given device
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleResult(message) {
        if(message.board_id !== this.board_id)
            return;

        switch(message.status) {
            case BAIKAL_STATUS_NONCE_READY:

                try {
                    const workIndex = message.work_idx,
                        work = this.ringBuffer.get(workIndex),
                        now = Date.now();

                    //this.index
                    console.log(`Found for ${message.board_id}: ${workIndex} / ${this.ringBuffer.index}`);


                    const timeSinceLastNonce = this.lastNonceFoundAt ? now - this.lastNonceFoundAt : 0;

                    this.lastNonceFoundAt = now;
                    this.lastNonceWorkIndex = workIndex;


                    const workRemain = Math.abs((workIndex-255-this.ringBuffer.index)%255);

                    console.log(`workRemain: ${workRemain} timeSinceLastNonce: ${timeSinceLastNonce}`);

                    const
                        blockHeader = this.algorithm.createBlockHeaderFromJob(work.job, work.extraNonce1, work.nonce2, message.nonce),
                        blockHash = this.algorithm.hash(blockHeader),
                        shareDifficulty = this.algorithm.getDifficultyForHash(blockHash);

                    if(shareDifficulty > this.difficulty) {
                        this.sharesFound += this.difficulty;
                    }

                    this.emit('share_found', {
                        board_id: this.id,
                        block_header: blockHeader,
                        block_hash: blockHash,
                        difficulty: shareDifficulty,
                        target: this.target,
                        nonce: message.nonce,
                        work: work
                    });

                } catch(e) {
                    console.log('Could not find work for workIndex: ',e);

                }

                break;

            case BAIKAL_STATUS_JOB_EMPTY:
                break;

            case BAIKAL_STATUS_NEW_MINER:
                this.emit('error');
                break;
        }

        this.temperature = message.temp;
    }

    /**
     * New work was sent to the given device
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleSendWork(message) {
        if(message.board_id !== this.board_id)
            return;

        this.clock = message.param << 1;
    }

    async requestInfo() {
        return await this.usbInterface.requestInfo(this.board_id);
    }

    async setOption(cutOffTemperature, fanSpeed) {
        return await this.usbInterface.setOption(this.board_id, cutOffTemperature, fanSpeed);
    }

    async addWork(work) {
        const workIndex = this.ringBuffer.push(work);

        try {
            await this.usbInterface.sendWork(this.board_id, workIndex, toBaikalAlgorithm(this.algorithm), this.board_target, work.blockHeader);

            //TODO: Move this into a work loop
            await this.usbInterface.requestResult(this.board_id);
        } catch(e) {
            console.log(`Could not send work to device: ${e}`);
        }

    }
}

exports.BaikalUsbBoard = BaikalUsbBoard;