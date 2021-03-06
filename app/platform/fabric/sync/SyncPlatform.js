/*
    SPDX-License-Identifier: Apache-2.0
*/

const path = require('path');
const fs = require('fs-extra');

const SyncService = require('../sync/SyncService');
const FabricUtils = require('../utils/FabricUtils');
const FabricEvent = require('./FabricEvent');

const helper = require('../../../common/helper');

const logger = helper.getLogger('SyncPlatform');
const ExplorerError = require('../../../common/ExplorerError');

const CRUDService = require('../../../persistence/fabric/CRUDService');
const MetricService = require('../../../persistence/fabric/MetricService');

const fabric_const = require('../utils/FabricConst').fabric.const;
const explorer_mess = require('../../../common/ExplorerMessage').explorer;

const config_path = path.resolve(__dirname, '../config.json');

class SyncPlatform {
  constructor(persistence, sender, findMissingBlock) {
    this.rand = Math.random();
    this.network_name;
    this.client_name;
    this.client;
    this.eventHub;
    this.sender = sender;
    this.persistence = persistence;
    this.syncService = new SyncService(this, this.persistence);
    this.blocksSyncTime = 60000;
    this.client_configs;
    this.findMissingBlock = findMissingBlock;
  }

  async initialize(args) {
    const _self = this;

    logger.debug(
      '******* Initialization started for child client process %s ******',
      this.client_name
    );

    // loading the config.json
    const all_config = JSON.parse(fs.readFileSync(config_path, 'utf8'));
    const network_configs = all_config[fabric_const.NETWORK_CONFIGS];

    if (args.length == 0) {
      // get the first network and first client
      this.network_name = Object.keys(network_configs)[0];
      this.client_name = Object.keys(
        network_configs[Object.keys(network_configs)[0]].clients
      )[0];
    } else if (args.length == 1) {
      // get the first client with respect to the passed network name
      this.network_name = args[0];
      this.client_name = Object.keys(
        network_configs[this.network_name].clients
      )[0];
    } else {
      this.network_name = args[0];
      this.client_name = args[1];
    }

    console.log(
      `\n${explorer_mess.message.MESSAGE_1002}`,
      this.network_name,
      this.client_name
    );

    // setting the block synch interval time
    await this.setBlocksSyncTime(all_config);

    logger.debug('Blocks synch interval time >> %s', this.blocksSyncTime);
    // update the discovery-cache-life as block synch interval time in global config
    global.hfc.config.set('discovery-cache-life', this.blocksSyncTime);
    global.hfc.config.set('initialize-with-discovery', true);

    const client_configs = network_configs[this.network_name];

    this.client_configs = await FabricUtils.setOrgEnrolmentPath(client_configs);

    this.client = await FabricUtils.createFabricClient(
      this.client_configs,
      this.client_name
    );
    if (!this.client) {
      throw new ExplorerError(explorer_mess.error.ERROR_2011);
    }

    let peerStatus = { status: false };
    console.log(
      'SyncPlatform[' + this.rand + '].initialize - this.client.adminpeers:',
      this.client.adminpeers.keys()
    );
    for (let [k, adminpeer] of this.client.adminpeers) {
      const peer = {
        requests: adminpeer.getUrl(),
        mspid: this.client_configs.organizations[
          this.client_configs.clients[this.client_name].organization
        ].mspid
      };
      const m =
        'SyncPlatform[' +
        this.rand +
        '].initialize - trying to request ' +
        peer.requests;
      console.log(m);
      logger.log(m);
      peerStatus = await this.client.getPeerStatus(peer);
      if (peerStatus.status == 'RUNNING') {
        if (adminpeer.getUrl() != this.client.getDefaultPeer().getUrl()) {
          this.client.setDefaultPeer(adminpeer.getPeer());
          console.log(
            'SyncPlatform[' +
              this.rand +
              '].initialize - replace default peer to:',
            adminpeer.getUrl()
          );
        }
        console.log(
          'SyncPlatform[' + this.rand + '].initialize - RUNNING:',
          adminpeer.getUrl()
        );
        break;
      }
      console.log('SyncPlatform[' + this.rand + '].initialize - try more');
    }
    console.log(
      'SyncPlatform[' + this.rand + '].initialize - peerStatus:',
      peerStatus
    );
    if (peerStatus.status) {
      // updating the client network and other details to DB
      const res = await this.syncService.synchNetworkConfigToDB(this.client);
      if (!res) {
        return;
      }

      // last blocknum of each channel_genesis_hash
      let lastBlocknumPerChannel = {};
      for (let [i, channelname] of Object.keys(
        this.client.client_config.channels
      ).entries()) {
        let channel_genesis_hash = this.client.getChannelGenHash(channelname);
        let rows = await this.persistence
          .getMetricService()
          .getLastBlockNumber(channel_genesis_hash);
        let lastBlockNum = 0;
        if (rows.length != 0) {
          lastBlockNum = rows[0]['blocknum'];
        }
        lastBlocknumPerChannel[channelname] = lastBlockNum;
      }
      console.log(`lastBlocknumPerChannel:`, lastBlocknumPerChannel);

      // start event
      this.eventHub = new FabricEvent(
        this.client,
        this.syncService,
        lastBlocknumPerChannel
      );
      await this.eventHub.initialize();

      // validating any missing block from the current client ledger
      // set blocksSyncTime property in platform config.json in minutes
      // wait until FabricEvent make its own connection complete. (1000ms is approximated.)
      const rand = Math.random();
      setTimeout(() => {
        _self.isChannelEventHubConnected(rand);
      }, 1000);
      logger.debug(
        '******* Initialization end for child client process %s ******',
        this.client_name
      );

      //TODO 여기서 blockSyncTime 후에 FabricEvent를 죽일 것인지, Synchronizer에서 blockSyncTime마다 SyncPlatform을 죽이고 다시 만들지
      // 후자가 깔끔한데 전자를 고민하는 것은 후자가 무거울 것이기 때문.
      // SyncPlatform을 한번 만들어놓고 계속 재사용하면 전자는 할 수가 없음.
    } else {
      const m = explorer_mess.error.ERROR_1009;
      console.error(m);
      logger.error(m);
      // throw new ExplorerError(explorer_mess.error.ERROR_1009);
    }
  }

  async isChannelEventHubConnected(rand) {
    for (const [channel_name, channel] of this.client.getChannels().entries()) {
      // validate channel event is connected
      const status = this.eventHub.isChannelEventHubConnected(channel_name);
      if (status) {
        console.log(
          'SyncPlatform[' +
            this.rand +
            '].isChannelEventHubConnected[' +
            rand +
            '] - before call SyncService.synchBlocks()'
        );
        await this.syncService.synchBlocks(this.client, channel);
      } else {
        // channel client is not connected then it will reconnect
        console.log(
          'SyncPlatform[' +
            this.rand +
            '].isChannelEventHubConnected[' +
            rand +
            '] - before call FabricEvent.connectChannelEventHub()'
        );
        this.eventHub.connectChannelEventHub(channel_name);
      }
    }
  }

  setBlocksSyncTime(blocksSyncTime) {
    if (blocksSyncTime) {
      const time = parseInt(blocksSyncTime, 10);
      if (!isNaN(time)) {
        // this.blocksSyncTime = 1 * 10 * 1000;
        this.blocksSyncTime = time * 60 * 1000;
      }
    }
  }

  setPersistenceService() {
    // setting platfrom specific CRUDService and MetricService
    this.persistence.setMetricService(
      new MetricService(this.persistence.getPGService())
    );
    this.persistence.setCrudService(
      new CRUDService(this.persistence.getPGService())
    );
  }

  send(notify) {
    if (this.sender) {
      this.sender.send(notify);
    }
  }

  destroy() {
    console.log('SyncPlatform[' + this.rand + '].destory');
    if (this.eventHub) {
      this.eventHub.disconnectEventHubs();
    }
  }
}

module.exports = SyncPlatform;
