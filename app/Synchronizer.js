/*
    SPDX-License-Identifier: Apache-2.0
*/

const syncconfig = require('./explorerconfig.json');
const helper = require('./common/helper');
const ExplorerError = require('./common/ExplorerError');

const logger = helper.getLogger('Synchronizer');
const SyncBuilder = require('./sync/SyncBuilder');
const PersistenceFactory = require('./persistence/PersistenceFactory');
const ExplorerSender = require('./sync/sender/ExplorerSender');

const explorer_const = require('./common/ExplorerConst').explorer.const;
const explorer_error = require('./common/ExplorerMessage').explorer.error;

let syncScanner;

class Synchronizer {
  constructor(args) {
    this.args = args;
    this.persistence;
    this.platform;
    this.handler;
  }

  async initialize() {
    const _self = this;

    if (!syncconfig[explorer_const.PERSISTENCE]) {
      throw new ExplorerError(explorer_error.ERROR_1001);
    }
    if (!syncconfig[syncconfig[explorer_const.PERSISTENCE]]) {
      throw new ExplorerError(
        explorer_error.ERROR_1002,
        syncconfig[explorer_const.PERSISTENCE]
      );
    }

    let pltfrm;
    if (syncconfig && syncconfig.sync && syncconfig.sync.platform) {
      pltfrm = syncconfig.sync.platform;
    } else {
      throw new ExplorerError(explorer_error.ERROR_1006);
    }

    // if (!this.args || this.args.length == 0) {
    // throw new ExplorerError(explorer_error.ERROR_1007);
    // }

    if (
      !(this.args && this.args.length > 2 && this.args[2] === '1') &&
      syncconfig.sync.type !== explorer_const.SYNC_TYPE_HOST
    ) {
      throw new ExplorerError(explorer_error.ERROR_1008);
    }

    this.persistence = await PersistenceFactory.create(
      syncconfig[explorer_const.PERSISTENCE],
      syncconfig[syncconfig[explorer_const.PERSISTENCE]]
    );

    const sender = new ExplorerSender(syncconfig.sync);
    sender.initialize();

    let blocksSyncTime = 60000;
    if (syncconfig.sync.blocksSyncTime) {
      const time = parseInt(syncconfig.sync.blocksSyncTime, 10);
      if (!isNaN(time)) {
        blocksSyncTime = time * 60 * 1000;
      }
    }

    this.handler = setInterval(async () => {
      if (_self.platform) {
        console.log('Synchronizer.initialize - destroying past SyncPlatform');
        _self.platform.destroy();
      }
      console.log('Synchronizer.initialize - building SyncPlatform');
      _self.platform = await SyncBuilder.build(
        pltfrm,
        _self.persistence,
        sender
      );
      _self.platform.setPersistenceService();
      _self.platform.setBlocksSyncTime(syncconfig.sync.blocksSyncTime);
      await _self.platform.initialize(_self.args);
      console.log(
        'Synchronizer.initialize - SyncPlatform initialized:',
        _self.platform.rand
      );
    }, blocksSyncTime);
    console.log('Synchronizer.initialize - handler:', this.handler);
  }

  close() {
    if (this.persistence) {
      // this.persistence.closeconnection();
    }
    if (this.platform) {
      console.log('Synchronizer.initialize - destroying SyncPlatform');
      this.platform.destroy();
    }
    if (this.handler) {
      console.log('Synchronizer.close - handler:', this.handler);
      clearInterval(this.handler);
    }
  }
}

module.exports = Synchronizer;
