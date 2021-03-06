/*
    SPDX-License-Identifier: Apache-2.0
*/
const helper = require('../../../common/helper');

const logger = helper.getLogger('FabricEvent');

class FabricEvent {
  constructor(client, fabricServices, lastBlocknumPerChannel) {
    this.rand = Math.random();
    this.client = client;
    this.fabricServices = fabricServices;
    this.channelEventHubs = new Map();
    this.lastBlocknumPerChannel = lastBlocknumPerChannel;
  }

  async initialize() {
    console.log('FabricEvent[' + this.rand + '].initialize');
    // creating channel event hub
    const channels = this.client.getChannels();
    for (const [channel_name, channel] of channels.entries()) {
      this.createChannelEventHub(channel);
      logger.debug(
        'Successfully created channel event hub for  [%s]',
        channel_name
      );
    }
  }

  createChannelEventHub(channel) {
    // create channel event hub
    const eventHub = channel.newChannelEventHub(this.client.defaultPeer);
    console.log(
      `FabricEvent[${
        this.rand
      }].createChannelEventHub - registering Block Event`
    );
    let opt = {};
    // DB가 비어있을때 (0번 블록부터 모두 가져와야 할 때) this.lastBlocknumPerChannel[channel.getName()]은 0이다.
    // 따라서 조건식이 false가 되고 if문도 실행되지 않으면서 이벤트 리스너가 가장 최신 블록 하나만 가져오게 됨..
    // 명시적인 undefined 체킹 통해 0번 블록을 가져오고, 원래 registerBlockEvent에서 0번 블록을 걸러내던 if문을 제거함.
    if (
      this.lastBlocknumPerChannel &&
      typeof this.lastBlocknumPerChannel[channel.getName()] !== 'undefined'
    ) {
      opt['startBlock'] = this.lastBlocknumPerChannel[channel.getName()];
    }
    eventHub.registerBlockEvent(
      async block => {
        console.log('Block Event listener');
        await this.fabricServices.processBlockEvent(this.client, block);
      },
      err => {
        logger.error('Block Event %s', err);
      },
      opt
    );
    this.connectChannelEventHub(channel.getName(), eventHub);
    // set channel event hub to map
    this.channelEventHubs.set(channel.getName(), eventHub);
  }

  connectChannelEventHub(channel_name, eventHub) {
    console.log(
      'FabricEvent[' + this.rand + '].connectChannelEventHub - eventHub:',
      eventHub ? eventHub.getName() : 'false'
    );
    const _self = this;
    if (eventHub) {
      eventHub.connect(true);
      setTimeout(
        channel_name => {
          _self.synchChannelBlocks(channel_name);
        },
        5000,
        channel_name
      );
    } else {
      // if channel event hub is not defined then create new channel event hub
      const channel = this.client.hfc_client.getChannel(channel_name);
      this.createChannelEventHub(channel);
      return false;
    }
  }

  isChannelEventHubConnected(channel_name) {
    const eventHub = this.channelEventHubs.get(channel_name);
    console.log(
      'FabricEvent[' + this.rand + '].isChannelEventHubConnected - eventHub: ',
      eventHub ? eventHub.getName() : 'false'
    );
    if (eventHub) {
      return eventHub.isconnected();
    }
    return false;
  }

  disconnectChannelEventHub(channel_name) {
    const eventHub = this.channelEventHubs.get(channel_name);
    console.log(
      'FabricEvent[' + this.rand + '].disconnectChannelEventHub - disconnect'
    );
    return eventHub.disconnect();
  }

  disconnectEventHubs() {
    console.log(
      'FabricEvent[' +
        this.rand +
        '].disconnectEventHubs - this.channelEventHubs.size:' +
        this.channelEventHubs.size
    );
    // disconnect all event hubs
    for (const [channel_name, eventHub] of this.channelEventHubs.entries()) {
      const status = this.isChannelEventHubConnected(channel_name);
      console.log(
        'FabricEvent[' +
          this.rand +
          '].disconnectEventHubs - status of ' +
          channel_name +
          ':' +
          status
      );
      if (status) {
        console.log(
          'FabricEvent[' +
            this.rand +
            '].disconnectEventHubs - before call disconnectChannelEventHub'
        );
        this.disconnectChannelEventHub(channel_name);
      }
    }
  }

  // channel event hub used to synch the blocks
  async synchChannelBlocks(channel_name) {
    if (this.isChannelEventHubConnected(channel_name)) {
      const channel = this.client.hfc_client.getChannel(channel_name);
      console.log(
        'FabricEvent[' +
          this.rand +
          '].synchChannelBlocks - before call SyncService.synchBlocks()'
      );
      await this.fabricServices.synchBlocks(this.client, channel);
    }
  }

  // Interval and peer event hub used to synch the blocks
  async synchBlocks() {
    // getting all channels list from client ledger
    const channels = await this.client
      .getHFC_Client()
      .queryChannels(this.client.getDefaultPeer().getName(), true);

    for (const channel of channels.channels) {
      const channel_name = channel.channel_id;
      if (!this.client.getChannels().get(channel_name)) {
        // initialize channel, if it is not exists in the client context
        await this.client.initializeNewChannel(channel_name);
        await this.fabricServices.synchNetworkConfigToDB(this.client);
      }
    }
    for (const channel of channels.channels) {
      const channel_name = channel.channel_id;
      // check channel event is connected
      if (this.isChannelEventHubConnected(channel_name)) {
        // call synch blocks
        const channel = this.client.hfc_client.getChannel(channel_name);
        await this.fabricServices.synchBlocks(this.client, channel);
      } else {
        const eventHub = this.channelEventHubs.get(channel_name);
        if (eventHub) {
          // connect channel event hub
          this.connectChannelEventHub(channel_name, eventHub);
        } else {
          const channel = this.client.getChannels().get(channel_name);
          if (channel) {
            // create channel event hub
            this.createChannelEventHub(channel);
          } else {
            // initialize channel, if it is not exists in the client context
            await this.client.initializeNewChannel(this, channel_name);
            await this.fabricServices.synchNetworkConfigToDB(this.client);
          }
        }
      }
    }
  }
}

module.exports = FabricEvent;
