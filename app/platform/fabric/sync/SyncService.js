/*
    SPDX-License-Identifier: Apache-2.0
*/

const fs = require('fs-extra');
const grpc = require('grpc');
const convertHex = require('convert-hex');
const helper = require('../../../common/helper');

const logger = helper.getLogger('SyncServices');
const ExplorerError = require('../../../common/ExplorerError');
const FabricUtils = require('../../../platform/fabric/utils/FabricUtils');
const fabric_const = require('../../../platform/fabric/utils/FabricConst')
  .fabric.const;
const explorer_error = require('../../../common/ExplorerMessage').explorer
  .error;

const _transProto = grpc.load(
  `${__dirname}/../../../../node_modules/fabric-client/lib/protos/peer/transaction.proto`
).protos;

const blocksInProcess = [];

// transaction validation code
const _validation_codes = {};
const keys = Object.keys(_transProto.TxValidationCode);
for (let i = 0; i < keys.length; i++) {
  const new_key = _transProto.TxValidationCode[keys[i]];
  _validation_codes[new_key] = keys[i];
}

class SyncServices {
  constructor(platform, persistence) {
    this.platform = platform;
    this.persistence = persistence;
    this.blocks = [];
    this.synchInProcess = [];
  }

  async initialize() {}

  async synchNetworkConfigToDB(client) {
    const channels = client.getChannels();
    for (const [channel_name, channel] of channels.entries()) {
      const block = await client.getGenesisBlock(channel);
      const channel_genesis_hash = await FabricUtils.generateBlockHash(
        block.header
      );
      const res = await this.insertNewChannel(
        client,
        channel,
        block,
        channel_genesis_hash
      );
      if (res) {
        await this.insertFromDiscoveryResults(
          client,
          channel,
          channel_genesis_hash
        );
      } else {
        return false;
      }
    }
    return true;
  }

  // insert new channel to DB
  async insertNewChannel(client, channel, block, channel_genesis_hash) {
    const channel_name = channel.getName();

    const channelInfo = await this.persistence
      .getCrudService()
      .getChannel(channel_name, channel_genesis_hash);

    if (!channelInfo) {
      const count = await this.persistence
        .getCrudService()
        .existChannel(channel_name);
      if (count.count === '0') {
        if (block.data && block.data.data.length > 0 && block.data.data[0]) {
          const createdt = await FabricUtils.getBlockTimeStamp(
            block.data.data[0].payload.header.channel_header.timestamp
          );
          const channel_row = {
            name: channel_name,
            createdt,
            blocks: 0,
            trans: 0,
            channel_hash: '',
            channel_version:
              block.data.data[0].payload.header.channel_header.version,
            channel_genesis_hash
          };
          await this.persistence.getCrudService().saveChannel(channel_row);
        }
      } else {
        const notify = {
          notify_type: fabric_const.NOTITY_TYPE_EXISTCHANNEL,
          network_name: this.platform.network_name,
          client_name: client.client_name,
          channel_name
        };
        this.platform.send(notify);
        throw new ExplorerError(explorer_error.ERROR_2013, channel_name);
        return false;
      }
    }
    return true;
  }

  async insertFromDiscoveryResults(client, channel, channel_genesis_hash) {
    const channel_name = channel.getName();
    const discoveryResults = await client.initializeChannelFromDiscover(
      channel_name
    );
    // insert peer
    if (discoveryResults && discoveryResults.peers_by_org) {
      for (const org_name in discoveryResults.peers_by_org) {
        const org = discoveryResults.peers_by_org[org_name];
        for (const peer of org.peers) {
          await this.insertNewPeer(peer, channel_genesis_hash, client);
        }
      }
    }
    // insert orderer
    if (discoveryResults && discoveryResults.orderers) {
      for (const org_name in discoveryResults.orderers) {
        const org = discoveryResults.orderers[org_name];
        for (const orderer of org.endpoints) {
          orderer.org_name = org_name;
          await this.insertNewOrderers(orderer, channel_genesis_hash, client);
        }
      }
    }
    // insert chaincode
    await this.insertNewChannelChaincode(
      client,
      channel,
      channel_genesis_hash,
      discoveryResults
    );
  }

  // insert new peer and channel relation
  async insertNewPeer(peer, channel_genesis_hash, client) {
    let eventurl = '';
    let requesturl = peer.endpoint;
    const host_port = peer.endpoint.split(':');
    if (
      client.client_config.peers &&
      client.client_config.peers[host_port[0]] &&
      client.client_config.peers[host_port[0]].url
    ) {
      requesturl = client.client_config.peers[host_port[0]].url;
    }
    if (
      client.client_config.peers &&
      client.client_config.peers[host_port[0]] &&
      client.client_config.peers[host_port[0]].eventUrl
    ) {
      eventurl = client.client_config.peers[host_port[0]].eventUrl;
    }

    const peer_row = {
      mspid: peer.mspid,
      requests: requesturl,
      events: eventurl,
      server_hostname: host_port[0],
      channel_genesis_hash,
      peer_type: 'PEER'
    };
    await this.persistence.getCrudService().savePeer(peer_row);
    const channel_peer_row = {
      peerid: host_port[0],
      channelid: channel_genesis_hash
    };
    await this.persistence
      .getCrudService()
      .savePeerChannelRef(channel_peer_row);
  }

  // insert new orderer and channel relation
  async insertNewOrderers(orderer, channel_genesis_hash, client) {
    let requesturl = `${orderer.host}:${orderer.port}`;
    if (
      client.client_config.orderers &&
      client.client_config.orderers[orderer.host] &&
      client.client_config.orderers[orderer.host].url
    ) {
      requesturl = client.client_config.orderers[orderer.host].url;
    }
    const orderer_row = {
      mspid: orderer.org_name,
      requests: requesturl,
      server_hostname: orderer.host,
      channel_genesis_hash,
      peer_type: 'ORDERER'
    };
    await this.persistence.getCrudService().savePeer(orderer_row);
    const channel_orderer_row = {
      peerid: orderer.host,
      channelid: channel_genesis_hash
    };
    await this.persistence
      .getCrudService()
      .savePeerChannelRef(channel_orderer_row);
  }

  // insert new chaincode, peer and channel relation
  async insertNewChannelChaincode(
    client,
    channel,
    channel_genesis_hash,
    discoveryResults
  ) {
    const chaincodes = await channel.queryInstantiatedChaincodes(
      client.getDefaultPeer(),
      true
    );
    for (const chaincode of chaincodes.chaincodes) {
      const chaincode_row = {
        name: chaincode.name,
        version: chaincode.version,
        path: chaincode.path,
        txcount: 0,
        createdt: new Date(),
        channel_genesis_hash
      };
      await this.persistence.getCrudService().saveChaincode(chaincode_row);
      if (discoveryResults && discoveryResults.peers_by_org) {
        for (const org_name in discoveryResults.peers_by_org) {
          const org = discoveryResults.peers_by_org[org_name];
          for (const peer of org.peers) {
            for (const c_code of peer.chaincodes) {
              if (
                c_code.name === chaincode.name &&
                c_code.version === chaincode.version
              ) {
                await this.insertNewChaincodePeerRef(
                  c_code,
                  peer.endpoint,
                  channel_genesis_hash
                );
              }
            }
          }
        }
      }
    }
  }

  // insert new chaincode relation with peer and channel
  async insertNewChaincodePeerRef(chaincode, endpoint, channel_genesis_hash) {
    const host_port = endpoint.split(':');
    const chaincode_peer_row = {
      chaincodeid: chaincode.name,
      cc_version: chaincode.version,
      peerid: host_port[0],
      channelid: channel_genesis_hash
    };
    await this.persistence
      .getCrudService()
      .saveChaincodPeerRef(chaincode_peer_row);
  }

  async synchBlocks(client, channel) {
    const client_name = client.getClientName();
    const channel_name = channel.getName();

    const synch_key = `${client_name}_${channel_name}`;
    if (this.synchInProcess.includes(synch_key)) {
      logger.info(
        `Block synch in process for >> ${client_name}_${channel_name}`
      );
      return;
    }
    this.synchInProcess.push(synch_key);

    // get channel information from ledger
    const channelInfo = await client
      .getHFC_Client()
      .getChannel(channel_name)
      .queryInfo(client.getDefaultPeer(), true);
    const channel_genesis_hash = client.getChannelGenHash(channel_name);
    const blockHeight = parseInt(channelInfo.height.low) - 1;
    // query missing blocks from DB
    const results = await this.persistence
      .getMetricService()
      .findMissingBlockNumber(channel_genesis_hash, blockHeight);
    try {
      console.log(
        'SyncService.synchBlocks - results:',
        JSON.stringify(results)
      );
    } catch (e) {
      console.error(e);
    }
    if (results) {
      for (const result of results) {
        // get block by number
        const block = await client
          .getHFC_Client()
          .getChannel(channel_name)
          .queryBlock(
            result.missing_id,
            client.getDefaultPeer().getName(),
            true
          );
        await this.processBlockEvent(client, block);
      }
    } else {
      logger.debug('Missing blocks not found for %s', channel_name);
    }
    const index = this.synchInProcess.indexOf(synch_key);
    this.synchInProcess.splice(index, 1);
  }

  async processBlockEvent(client, block) {
    console.log('SyncService.processBlockEvent - ', block.header.number);
    const _self = this;
    // get the first transaction
    const first_tx = block.data.data[0];
    // the 'header' object contains metadata of the transaction
    const header = first_tx.payload.header;
    const channel_name = header.channel_header.channel_id;
    const blockPro_key = `${channel_name}_${block.header.number}`;

    if (blocksInProcess.includes(blockPro_key)) {
      return 'Block already in processing';
    }
    blocksInProcess.push(blockPro_key);

    logger.debug('New Block  >>>>>>> %j', block);
    let channel_genesis_hash = client.getChannelGenHash(channel_name);
    // checking block is channel CONFIG block
    if (!channel_genesis_hash) {
      // get discovery and insert channel details to db and create new channel object in client context
      setTimeout(
        async (client, channel_name, block) => {
          await client.initializeNewChannel(channel_name);
          channel_genesis_hash = client.getChannelGenHash(channel_name);
          // inserting new channel details to DB
          const channel = client.hfc_client.getChannel(channel_name);
          await _self.insertNewChannel(
            client,
            channel,
            block,
            channel_genesis_hash
          );
          await _self.insertFromDiscoveryResults(
            client,
            channel,
            channel_genesis_hash
          );

          const notify = {
            notify_type: fabric_const.NOTITY_TYPE_NEWCHANNEL,
            network_name: _self.platform.network_name,
            client_name: client.client_name,
            channel_name
          };

          _self.platform.send(notify);
        },
        10000,
        client,
        channel_name,
        block
      );
    } else if (
      header.channel_header.typeString === fabric_const.BLOCK_TYPE_CONFIG
    ) {
      setTimeout(
        async (client, channel_name, channel_genesis_hash) => {
          // get discovery and insert new peer, orders details to db
          const channel = client.hfc_client.getChannel(channel_name);
          await client.initializeChannelFromDiscover(channel_name);
          await _self.insertFromDiscoveryResults(
            client,
            channel,
            channel_genesis_hash
          );
          const notify = {
            notify_type: fabric_const.NOTITY_TYPE_UPDATECHANNEL,
            network_name: _self.platform.network_name,
            client_name: client.client_name,
            channel_name
          };

          _self.platform.send(notify);
        },
        10000,
        client,
        channel_name,
        channel_genesis_hash
      );
    }
    const createdt = await FabricUtils.getBlockTimeStamp(
      header.channel_header.timestamp
    );
    const blockhash = await FabricUtils.generateBlockHash(block.header);
    if (channel_genesis_hash) {
      const block_row = {
        blocknum: block.header.number,
        datahash: block.header.data_hash,
        prehash: block.header.previous_hash,
        txcount: block.data.data.length,
        createdt,
        prev_blockhash: '',
        blockhash,
        channel_genesis_hash
      };
      const txLen = block.data.data.length;
      for (let i = 0; i < txLen; i++) {
        const txObj = block.data.data[i];
        const txid = txObj.payload.header.channel_header.tx_id;
        let validation_code = '';
        let endorser_signature = '';
        let payload_proposal_hash = '';
        let endorser_id_bytes = '';
        let chaincode_proposal_input = '';
        let chaincode = '';
        let rwset;
        let readSet;
        let writeSet;
        let chaincodeID;
        let status;
        let mspId = [];
        if (txid != undefined && txid != '') {
          const validation_codes =
            block.metadata.metadata[block.metadata.metadata.length - 1];
          const val_code = validation_codes[i];
          validation_code = convertValidationCode(val_code);
        }
        let envelope_signature = txObj.signature;
        if (envelope_signature != undefined) {
          envelope_signature = convertHex.bytesToHex(envelope_signature);
        }
        let payload_extension = txObj.payload.header.channel_header.extension;
        if (payload_extension != undefined) {
          payload_extension = convertHex.bytesToHex(payload_extension);
        }
        let creator_nonce = txObj.payload.header.signature_header.nonce;
        if (creator_nonce != undefined) {
          creator_nonce = convertHex.bytesToHex(creator_nonce);
        }
        const creator_id_bytes =
          txObj.payload.header.signature_header.creator.IdBytes;
        if (txObj.payload.data.actions != undefined) {
          chaincode =
            txObj.payload.data.actions[0].payload.action
              .proposal_response_payload.extension.chaincode_id.name;
          chaincodeID = new Uint8Array(
            txObj.payload.data.actions[0].payload.action.proposal_response_payload.extension
          );
          status =
            txObj.payload.data.actions[0].payload.action
              .proposal_response_payload.extension.response.status;
          mspId = txObj.payload.data.actions[0].payload.action.endorsements.map(
            i => i.endorser.Mspid
          );
          rwset =
            txObj.payload.data.actions[0].payload.action
              .proposal_response_payload.extension.results.ns_rwset;
          readSet = rwset.map(i => ({
            chaincode: i.namespace,
            set: i.rwset.reads
          }));
          writeSet = rwset.map(i => ({
            chaincode: i.namespace,
            set: i.rwset.writes
          }));
          chaincode_proposal_input =
            txObj.payload.data.actions[0].payload.chaincode_proposal_payload
              .input.chaincode_spec.input.args;
          if (chaincode_proposal_input != undefined) {
            let inputs = '';
            for (const input of chaincode_proposal_input) {
              inputs =
                (inputs === '' ? inputs : `${inputs},`) +
                convertHex.bytesToHex(input);
            }
            chaincode_proposal_input = inputs;
          }
          endorser_signature =
            txObj.payload.data.actions[0].payload.action.endorsements[0]
              .signature;
          if (endorser_signature != undefined) {
            endorser_signature = convertHex.bytesToHex(endorser_signature);
          }
          payload_proposal_hash =
            txObj.payload.data.actions[0].payload.action
              .proposal_response_payload.proposal_hash;
          endorser_id_bytes =
            txObj.payload.data.actions[0].payload.action.endorsements[0]
              .endorser.IdBytes;
        }
        let function_arguments = getChaincodeFunctionAndArguments(writeSet);
        const kiesnet_function = function_arguments.function
          ? function_arguments.function
          : '';
        let kiesnet_arguments = '';
        try {
          kiesnet_arguments = JSON.stringify(function_arguments.arguments);
        } catch (err) {
          console.warn(err.message);
        }
        console.log(
          'SyncService.processBlock - ',
          kiesnet_function,
          kiesnet_arguments
        );

        const read_set = JSON.stringify(readSet, null, 2);
        const write_set = JSON.stringify(writeSet, null, 2);

        if (typeof read_set === 'string' || read_set instanceof String) {
          console.log('read_set length', read_set.length);
          const bytes = Buffer.byteLength(write_set, 'utf8');
          const kb = (bytes + 512) / 1024;
          const mb = (kb + 512) / 1024;
          const size = `${mb} MB`;
          console.log('write_set size >>>>>>>>> : ', size);
        }

        const chaincode_id = String.fromCharCode.apply(null, chaincodeID);
        // checking new chaincode is deployed
        if (
          header.channel_header.typeString ===
            fabric_const.BLOCK_TYPE_ENDORSER_TRANSACTION &&
          chaincode === fabric_const.CHAINCODE_LSCC
        ) {
          setTimeout(
            async (client, channel_name, channel_genesis_hash) => {
              const channel = client.hfc_client.getChannel(channel_name);
              // get discovery and insert chaincode details to db
              await _self.insertFromDiscoveryResults(
                client,
                channel,
                channel_genesis_hash
              );

              const notify = {
                notify_type: fabric_const.NOTITY_TYPE_CHAINCODE,
                network_name: _self.platform.network_name,
                client_name: client.client_name,
                channel_name
              };

              _self.platform.send(notify);
            },
            10000,
            client,
            channel_name,
            channel_genesis_hash
          );
        }
        const transaction_row = {
          blockid: block.header.number,
          txhash: txObj.payload.header.channel_header.tx_id,
          createdt,
          chaincodename: chaincode,
          chaincode_id,
          status,
          creator_msp_id: txObj.payload.header.signature_header.creator.Mspid,
          endorser_msp_id: mspId,
          type: txObj.payload.header.channel_header.typeString,
          read_set,
          write_set,
          channel_genesis_hash,
          validation_code,
          envelope_signature,
          payload_extension,
          creator_nonce,
          chaincode_proposal_input,
          endorser_signature,
          creator_id_bytes,
          payload_proposal_hash,
          endorser_id_bytes,
          kiesnet_function,
          kiesnet_arguments
        };

        // insert transaction
        const res = await this.persistence
          .getCrudService()
          .saveTransaction(transaction_row);
      }
      // insert block
      const status = await this.persistence
        .getCrudService()
        .saveBlock(block_row);
      if (status) {
        // push last block
        const notify = {
          notify_type: fabric_const.NOTITY_TYPE_BLOCK,
          network_name: _self.platform.network_name,
          client_name: client.client_name,
          channel_name,
          title: `Block ${
            block.header.number
          } added to Channel: ${channel_name}`,
          type: 'block',
          message: `Block ${block.header.number} established with ${
            block.data.data.length
          } tx`,
          time: createdt,
          txcount: block.data.data.length,
          datahash: block.header.data_hash
        };

        _self.platform.send(notify);
      }
    } else {
      logger.error('Failed to process the block %j', block);
    }
    const index = blocksInProcess.indexOf(blockPro_key);
    blocksInProcess.splice(index, 1);
  }

  getCurrentChannel() {}

  getPlatform() {
    return this.platform;
  }

  getPersistence() {
    return this.persistence;
  }
}

module.exports = SyncServices;
// transaction validation code
function convertValidationCode(code) {
  if (typeof code === 'string') {
    return code;
  }
  return _validation_codes[code];
}

function convertWriteSet(writeSet) {
  // return {chaincode:{doctype:[doc0, doc1, ...]}}
  let exists = {};
  for (const i in writeSet) {
    if (writeSet[i].chaincode == 'lscc') {
      continue;
    }
    const chaincode = writeSet[i].chaincode.replace('kiesnet-cc-', 'kiesnet-');
    for (const j in writeSet[i].set) {
      const key = writeSet[i].set[j].key;
      const doctype = key.substring(0, key.indexOf('_'));
      const k = chaincode + '.' + doctype;
      if (doctype.length > 0) {
        let value = null;
        if (writeSet[i].set[j].value.length > 0) {
          try {
            value = JSON.parse(writeSet[i].set[j].value);
          } catch (err) {
            console.warn(
              'convertWriteSet:',
              err.message,
              writeSet[i].set[j].value
            );
          }
          if (chaincode == 'kiesnet-contract' && doctype == 'CTR') {
            try {
              value.document = JSON.parse(value.document);
            } catch (err) {
              console.warn(
                'convertWriteSet:',
                err.message,
                writeSet[i].set[j].value
              );
            }
          }
        } else {
          if (writeSet[i].set[j].is_delete) {
            value = 'deleted';
          }
        }
        if (Array.isArray(exists[k])) {
          exists[k].push(value);
        } else {
          exists[k] = value === null ? [] : [value];
        }
      }
    }
  }
  return exists;
}

// block 최초 sync시 db에 넣고, kienset_function, kiesnet_arguments가 안들어갔으면 조회시 계산해서 넣고, 잘못 들어갔으면 백엔드를 만들어서 다시 계산해서 넣기?
// 이런 로직 자체가 쓰레기같기도 한데, 그러면 아예 chaincode에서 abstract를 만들어서 원장에 저장해버릴 것인지?
// amount는 소유권의 변경이 있을 때에만 표시
//   pending을 별도로 표시하지 않고 from/to 한쪽이 비어있으면 pending으로 보면 된다.
//   token이 나간 address를 무조건 from으로, token이 들어간 address를 무조건 to로 표현
//   withdraw, prune은 from/to를 표기하지 않음
//   account 기준 검색을 넣었을 때 검색결과에 포함되지 않는 점이 문제될 것인지?
//   contract cancel/expire인 경우를 고려하면 transfer/pay contract create인 경우 to를 넣지 않는게 더 자연스럽다.
// contract executed인 경우 'contract executed'와 dtype를 병기
function getChaincodeFunctionAndArguments(writeSet) {
  let exists = convertWriteSet(writeSet);

  let result = { function: '', arguments: {} };

  if (exists['kiesnet-token.BLOG']) {
    if (exists['kiesnet-token.BLOG'].length == 1) {
      switch (exists['kiesnet-token.BLOG'][0].type) {
        case 0:
          // tokenCreate or tokenMint
          result.function = 'token/mint';
          result.arguments.to = exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.amount = exists['kiesnet-token.BLOG'][0].diff;
          if (exists['kiesnet-token.ACC'] && exists['kiesnet-token.HLD']) {
            result.function = 'token/create';
          }
          break;
        case 1:
          result.function = 'token/burn';
          result.arguments.to = exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.amount = exists['kiesnet-token.BLOG'][0].diff;
          break;
        case 2:
          // transfer with pending
          // exists['kiesnet-token.PBLC'][0].type 검사는 어차피 0일 테니 할 필요가 없다.
          result.function = 'transfer';
          result.arguments.from =
            exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.to = exists['kiesnet-token.BLOG'][0].rid;
          result.arguments.amount = Math.abs(
            exists['kiesnet-token.BLOG'][0].diff
          );
          result.arguments.fee = 0;
          break;
        case 3:
          // trasfer contract executed without pending
          result.function = 'contract/execute (transfer)';
          result.arguments.from = exists['kiesnet-token.BLOG'][0].rid;
          result.arguments.to = exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.amount = exists['kiesnet-token.BLOG'][0].diff;
          result.arguments.fee = 0;
          break;
        case 5:
          result.function = 'withdraw';
          break;
        case 6:
          result.function = 'pay';
          result.arguments.from =
            exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.to = exists['kiesnet-token.BLOG'][0].rid;
          result.arguments.amount = exists['kiesnet-token.PAY'][0].amount;
          break;
        case 7:
          result.function = 'refund';
          result.arguments.from = exists['kiesnet-token.BLOG'][0].rid;
          result.arguments.to = exists['kiesnet-token.BLOG'][0]['@balance_log'];
          result.arguments.amount = exists['kiesnet-token.BLOG'][0].diff;
          break;
        case 8:
          result.function = 'pay/prune';
          result.arguments.fee = 0;
          break;
        case 9:
          result.function = 'fee/prune';
          break;
      }
    } else if (exists['kiesnet-token.BLOG'].length == 2) {
      result.function = 'transfer';
      result.arguments.fee = 0;
      for (let balanceLog of exists['kiesnet-token.BLOG']) {
        if (balanceLog.type == 2) {
          result.arguments.from = balanceLog['@balance_log'];
        }
        if (balanceLog.type == 3) {
          result.arguments.amount = balanceLog.diff;
          result.arguments.to = balanceLog['@balance_log'];
        }
      }
    }
  } else if (exists['kiesnet-token.ACC']) {
    result.arguments.address = exists['kiesnet-token.ACC'][0]['@account'];
    if (Object.keys(exists).length == 1) {
      result.function = 'account/unsuspend';
      if (exists['kiesnet-token.ACC'][0].suspended_time) {
        result.function = 'account/suspend';
      }
    } else {
      if (exists['kiesnet-token.BLC'] && exists['kiesnet-token.HLD']) {
        result.function = 'account/create';
      } else if (!exists['kiesnet-token.BLC']) {
        result.function = 'account/holder/add';
        if (exists['kiesnet-token.HLD'][0] === 'deleted') {
          result.function = 'account/holder/remove';
        }
      }
    }
  } else if (exists['kiesnet-id.CERT']) {
    if (Object.keys(exists).length == 1) {
      result.function = 'register';
    }
    //TODO revoke 등
  }

  // add contract info
  if (exists['kiesnet-contract.CTR']) {
    let document = exists['kiesnet-contract.CTR'][0].document;
    let dtype = document[0];
    if (exists['kiesnet-contract.CTR'][0].canceled_time) {
      // contract canceled
      result.function = 'contract/cancel (' + dtype + ')';
    } else {
      switch (exists['kiesnet-contract.CTR'][0].approved_count) {
        case 1:
          // contract created
          result.function = 'contract/create (' + dtype + ')';
          break;
        case exists['kiesnet-contract.CTR'][0].signers_count:
          result.function = 'contract/execute (' + dtype + ')';
          if (
            Array.isArray(exists['kiesnet-token.PBLC']) &&
            exists['kiesnet-token.PBLC'].length == 2
          ) {
            // transfer contract executed with pending인 경우 balance log가 남지 않는다.
            for (let pendingBalance of exists['kiesnet-token.PBLC']) {
              if (pendingBalance !== 'deleted') {
                result.arguments.from = pendingBalance.rid;
                result.arguments.to = pendingBalance.account;
                result.arguments.amount = pendingBalance.amount;
                break;
              }
            }
          } else if (exists['kiesnet-token.PAY']) {
            // pay contract executed인 경우 balance log가 남지 않는다.
            result.arguments.from = exists['kiesnet-token.PAY'][0].rid;
            result.arguments.to = exists['kiesnet-token.PAY'][0]['@pay'];
            result.arguments.amount = exists['kiesnet-token.PAY'][0].amount;
          }
          break;
        default:
          result.function = 'contract/approve (' + dtype + ')';
      }
    }
  }

  // add fee info
  if (exists['kiesnet-token.FEE']) {
    result.arguments.fee = exists['kiesnet-token.FEE'][0].amount;
  }

  if (result.arguments.amount !== undefined) {
    result.arguments.amount = format(result.arguments.amount, 8);
  }

  if (result.arguments.fee !== undefined) {
    result.arguments.fee = format(result.arguments.fee, 8);
  }

  return result;
}

// It trims trailing 0s.
function format(number, decimal) {
  if (number === 0 || number === '0') {
    return '0';
  }
  let sign = parseInt(number) < 0 ? '-' : '';
  let absstr = Math.abs(number).toString();
  let monetary = '0';
  let fraction;
  if (absstr.length > decimal) {
    let integer = absstr.substring(0, absstr.length - decimal);
    fraction = absstr.substring(absstr.length - decimal);
    let i1 = integer.length % 3;
    let m = i1 == 0 ? [] : [integer.substring(0, i1)];
    for (let i2 = 0; i2 < (integer.length - i1) / 3; i2++) {
      m.push(integer.substring(i1 + i2 * 3, i1 + i2 * 3 + 3));
    }
    monetary = m.join(',');
  } else if (absstr.length == decimal) {
    fraction = absstr;
  } else {
    fraction = absstr.padStart(decimal, '0');
  }
  fraction = fraction.replace(/0+$/, ''); // rtrim
  let p = fraction.length == 0 ? '' : '.'; // decimal point
  if (fraction.length > 4) {
    fraction = fraction.substring(0, 4) + ' ' + fraction.substring(4);
  }
  return `${sign}${monetary}${p}${fraction}`;
}
