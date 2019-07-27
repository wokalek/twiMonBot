import Router, {RouterReq, RouterRes, TCallbackQuery, TChat, TInlineKeyboardButton, TMessage} from "./router";
import htmlSanitize from "./tools/htmlSanitize";
import ErrorWithCode from "./tools/errorWithCode";
import pageBtnList from "./tools/pageBtnList";
import splitTextByPages from "./tools/splitTextByPages";
import resolvePath from "./tools/resolvePath";
import LogFile from "./logFile";
import ensureMap from "./tools/ensureMap";
import arrayByPart from "./tools/arrayByPart";
import promiseTry from "./tools/promiseTry";
import Main from "./main";
import {IChannel, IChatWithChannel} from "./db";
import {getButtonText, getString} from "./tools/streamToString";
import ChatSender from "./chatSender";
import parallel from "./tools/parallel";

const debug = require('debug')('app:Chat');
const jsonStringifyPretty = require("json-stringify-pretty-compact");
const fs = require('fs');

interface RouterReqWithChat extends RouterReq {
  chat: IChatWithChannel;
}

interface RouterReqWithChannels extends RouterReq {
  channels: IChannel[];
}

class Chat {
  main: Main;
  log: LogFile;
  private router: Router;
  constructor(/**Main*/main: Main) {
    this.main = main;
    this.log = new LogFile('chat');

    this.router = new Router(main);

    this.router.textOrCallbackQuery = this.router.custom(['text', 'callback_query']);

    this.main.bot.on('message', (message: TMessage) => {
      this.router.handle('message', message);
    });
    this.main.bot.on('callback_query', (callbackQuery: TCallbackQuery) => {
      this.router.handle('callback_query', null, callbackQuery);
    });

    this.base();
    this.menu();
    this.user();
    this.admin();
  }

  base() {
    this.router.message((req, res, next) => {
      const {migrate_to_chat_id: targetChatId, migrate_from_chat_id: sourceChatId} = req.message;
      if (targetChatId || sourceChatId) {
        return promiseTry(async () => {
          if (targetChatId) {
            await this.main.db.changeChatId(req.chatId, '' + targetChatId);
            this.log.write(`[migrate msg] ${req.chatId} > ${targetChatId}`);
          }
          if (sourceChatId) {
            await this.main.db.changeChatId('' + sourceChatId, req.chatId);
            this.log.write(`[migrate msg] ${req.chatId} < ${sourceChatId}`);
          }
        }).then(next, (err) => {
          debug('Process message %s %j error %o', req.chatId, req.message, err);
        });
      } else {
        return next();
      }
    });

    this.router.textOrCallbackQuery(/(.+)/, (req, res, next) => {
      next();
      if (req.message) {
        this.main.tracker.track(req.chatId, {
          ec: 'command',
          ea: req.command,
          el: req.message.text,
          t: 'event',
        });
      } else
      if (req.callback_query) {
        const data = req.callback_query.data;
        let command = '';
        let m = /(\/[^?\s]+)/.exec(data);
        if (m) {
          command = m[1];
        }
        const msg = Object.assign({}, req.callback_query.message, {
          text: data,
          from: req.callback_query.from
        });
        this.main.tracker.track(msg.chat.id, {
          ec: 'command',
          ea: command,
          el: msg.text,
          t: 'event',
        });
      }
    });

    this.router.callback_query((req, res, next) => {
      return this.main.bot.answerCallbackQuery(req.callback_query.id).then(next);
    });

    this.router.text(/\/ping/, (req, res) => {
      return this.main.bot.sendMessage(req.chatId, 'pong').catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });
  }

  menu() {
    const sendMenu = (chatId: number, page: number) => {
      const help = this.main.locale.getMessage('help');
      return this.main.bot.sendMessage(chatId, help, {
        disable_web_page_preview: true,
        reply_markup: JSON.stringify({
          inline_keyboard: getMenu(page)
        })
      });
    };

    this.router.text(/\/(start|menu|help)/, (req, res) => {
      return sendMenu(req.chatId, 0).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.callback_query(/\/menu(?:\/(?<page>\d+))?/, (req, res) => {
      const page = parseInt(req.params.page || '0', 10);
      return this.main.bot.editMessageReplyMarkup(JSON.stringify({
        inline_keyboard: getMenu(page)
      }), {
        chat_id: req.chatId,
        message_id: req.messageId
      }).catch((err: any) => {
        if (/message to edit not found/.test(err.message)) {
          return sendMenu(req.chatId, page);
        } else
        if (/message is not modified/.test(err.message)) {
          // pass
        } else {
          throw err;
        }
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/top/, (req, res) => {
      return Promise.all([
        this.main.db.getChatIdChannelIdChatIdCount(),
        this.main.db.getChatIdChannelIdChannelIdCount(),
        this.main.db.getChatIdChannelIdTop10(),
      ]).then(([serviceChatCountList, serviceChannelCountList, serviceChannelChatCountList]) => {
        const lines = [];

        const userCount = serviceChatCountList.reduce((sum, {chatCount}) => sum + chatCount, 0);
        const channelCount = serviceChannelCountList.reduce((sum, {channelCount}) => sum + channelCount, 0);

        lines.push(this.main.locale.getMessage('users').replace('{count}', '' + userCount));
        lines.push(this.main.locale.getMessage('channels').replace('{count}', '' + channelCount));

        const serviceIdTop10: Map<string, [string, number][]> = new Map();
        serviceChannelChatCountList.forEach(({title, service, chatCount}) => {
          const top10 = ensureMap(serviceIdTop10, service, []);
          top10.push([title, chatCount]);
        });

        serviceIdTop10.forEach((top10) => {
          top10.sort(([,a], [,b]) => a === b ? 0 : a > b ? -1 : 1);
        });

        serviceIdTop10.forEach((channels, serviceId) => {
          const service = this.main.getServiceById(serviceId);
          const name = service.name;
          lines.push('');
          lines.push(`${name}:`);

          channels.forEach(([title, chatCount], index) => {
            lines.push((index + 1) + '. ' + title);
          });
        });

        return this.main.bot.sendMessage(req.chatId, lines.join('\n'), {
          disable_web_page_preview: true
        });
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    let liveTime: string = null;
    this.router.textOrCallbackQuery(/\/about/, (req, res) => {
      if (!liveTime) {
        try {
          liveTime = JSON.parse(fs.readFileSync('./liveTime.json', 'utf8')).message;
        } catch (err) {
          debug('Read liveTime.json error! %o', err);
          liveTime = '';
        }
      }

      const message = liveTime.replace(/\$remainFrom\(([^)]+)\)/, (str, date) => {
        const m = /(\d{4}).(\d{2}).(\d{2})/.exec(date);
        if (m) {
          // @ts-ignore
          const endTime = (new Date(m[1], m[2], m[3])).getTime();
          const month =Math.trunc((endTime - Date.now()) / 1000 / 60 / 60 / 24 / 30 * 10) / 10;
          return `${month} months`;
        }
        return str;
      });

      return this.main.bot.sendMessage(req.chatId, message).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });
  }

  user() {
    const provideChat = (req: RouterReqWithChat, res: RouterRes, next: () => void) => {
      return this.main.db.ensureChat('' + req.chatId).then((chat) => {
        req.chat = chat;
        next();
      }, (err: any) => {
        debug('ensureChat error! %o', err);
        this.main.bot.sendMessage(req.chatId, 'Oops something went wrong...');
      });
    };

    const provideChannels = (req: RouterReqWithChannels, res: RouterRes, next: () => void) => {
      return this.main.db.getChannelsByChatId('' + req.chatId).then((channels) => {
        req.channels = channels;
        next();
      }, (err: any) => {
        debug('ensureChannels error! %o', err);
        this.main.bot.sendMessage(req.chatId, 'Oops something went wrong...');
      });
    };

    const withChannels = (req: RouterReqWithChannels, res: RouterRes, next: () => void) => {
      if (req.channels.length) {
        next();
      } else {
        this.main.bot.sendMessage(req.chatId, this.main.locale.getMessage('emptyServiceList'));
      }
    };

    this.router.callback_query(/\/cancel\/(?<command>[^\s]+)/, (req, res) => {
      const command = req.params.command;

      const cancelText = this.main.locale.getMessage('commandCanceled').replace('{command}', command);
      return this.main.bot.editMessageText(cancelText, {
        chat_id: req.chatId,
        message_id: req.messageId
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/add(?:\s+(?<query>.+$))?/, provideChat, (req, res) => {
      const query = req.params.query;
      let requestedData: string = null;

      return promiseTry(() => {
        if (query) {
          return {query: query.trim(), messageId: undefined};
        }

        const messageText = this.main.locale.getMessage('enterChannelName');
        const cancelText = this.main.locale.getMessage('commandCanceled').replace('{command}', 'add');
        return requestData(req.chatId, req.fromId, messageText, cancelText).then(({req, msg}) => {
          requestedData = req.message.text;
          this.main.tracker.track(req.chatId, {
            ec: 'command',
            ea: '/add',
            el: req.message.text,
            t: 'event'
          });
          return {query: req.message.text.trim(), messageId: msg.message_id};
        });
      }).then(({query, messageId}: {query: string, messageId?: number}) => {
        return promiseTry(() => {
          const service = this.main.services.find((service) => service.match(query));
          if (service) {
            return {service, messageId};
          }

          const messageText = this.main.locale.getMessage('enterService');
          const cancelText = this.main.locale.getMessage('commandCanceled').replace('{command}', 'add');
          const chooseKeyboard = [
            ...arrayByPart(this.main.services.map((service) => {
              return {
                text: service.name,
                callback_data: '/choose/' + service.id
              };
            }), 2),
            [{
              text: 'Cancel',
              callback_data: '/choose/cancel'
            }]
          ];
          return requestChoose(req.chatId, req.fromId, messageId, messageText, cancelText, chooseKeyboard).then(({req, msg}) => {
            const service = this.main.getServiceById(req.params.value);
            return {service, messageId: msg.message_id};
          });
        }).then(({service, messageId}) => {
          return this.main.db.getChannelCountByChatId(req.chatId).then((count) => {
            if (count >= 100) {
              throw new ErrorWithCode('Channels limit exceeded', 'CHANNELS_LIMIT');
            }
            return service.findChannel(query);
          }).then((serviceChannel) => {
            return this.main.db.ensureChannel(service, serviceChannel).then((channel: IChannel) => {
              return this.main.db.putChatIdChannelId(req.chatId, channel.id).then((created: boolean) => {
                return {channel, created};
              });
            });
          }).then(({channel, created}: {channel: IChannel, created: boolean}) => {
            let message = null;
            if (!created) {
              message = this.main.locale.getMessage('channelExists');
            } else {
              const {title, url} = channel;
              message = this.main.locale.getMessage('channelAdded')
                .replace('{channelName}', htmlSanitize('a', title, url))
                .replace('{serviceName}', htmlSanitize(service.name));
            }
            return editOrSendNewMessage(req.chatId, messageId, message, {
              disable_web_page_preview: true,
              parse_mode: 'HTML'
            }).then(() => {
              return this.main.db.getStreamsWithChannelByChannelIds([channel.id]).then((streams) => {
                const chatSender = new ChatSender(this.main, req.chat);
                return parallel(1, streams, (stream) => {
                  if (!stream.isOffline && !stream.isTimeout) {
                    return chatSender.sendStream(stream);
                  }
                });
              });
            });
          }, async (err: any) => {
            let isResolved = false;
            let message = null;
            if ([
              'INCORRECT_CHANNEL_ID',
              'CHANNEL_BY_VIDEO_ID_IS_NOT_FOUND',
              'INCORRECT_USERNAME', 'CHANNEL_BY_USER_IS_NOT_FOUND',
              'QUERY_IS_EMPTY', 'CHANNEL_BY_QUERY_IS_NOT_FOUND',
              'CHANNEL_BY_ID_IS_NOT_FOUND', 'CHANNEL_BROADCASTS_IS_NOT_FOUND'
            ].includes(err.code)) {
              isResolved = true;
              message = this.main.locale.getMessage('channelIsNotFound').replace('{channelName}', query);
            } else
            if (err.code === 'CHANNELS_LIMIT') {
              isResolved = true;
              message = err.message;
            } else {
              message = 'Unexpected error';
            }
            await editOrSendNewMessage(req.chatId, messageId, message, {
              disable_web_page_preview: true
            });
            if (!isResolved) {
              throw err;
            }
          });
        });
      }).catch((err: any) => {
        if (['RESPONSE_COMMAND', 'RESPONSE_TIMEOUT', 'RESPONSE_CANCEL'].includes(err.code)) {
          // pass
        } else {
          debug('%j %j error %o', req.command, requestedData, err);
        }
      });
    });

    this.router.callback_query(/\/clear\/confirmed/, (req, res) => {
      return this.main.db.deleteChatById(req.chatId).then(() => {
        this.log.write(`[deleted] ${req.chatId}, cause: /clear`);
        return this.main.bot.editMessageText(this.main.locale.getMessage('cleared'), {
          chat_id: req.chatId,
          message_id: req.messageId
        });
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/clear/, (req, res) => {
      return this.main.bot.sendMessage(req.chatId, this.main.locale.getMessage('clearSure'), {
        reply_markup: JSON.stringify({
          inline_keyboard: [[{
            text: 'Yes',
            callback_data: '/clear/confirmed'
          }, {
            text: 'No',
            callback_data: '/cancel/clear'
          }]]
        })
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.callback_query(/\/delete\/(?<channelId>.+)/, (req, res) => {
      const channelId = req.params.channelId;

      return this.main.db.getChannelById(channelId).then((channel) => {
        return this.main.db.deleteChatIdChannelId(req.chatId, channelId).then((count) => {
          return {channel, deleted: !!count};
        });
      }).then(({channel, deleted}) => {
        return this.main.bot.editMessageText(this.main.locale.getMessage('channelDeleted').replace('{channelName}', channel.title), {
          chat_id: req.chatId,
          message_id: req.messageId
        });
      }, async (err: any) => {
        let isResolved = false;
        let message = null;
        if (err.code === 'CHANNEL_IS_NOT_FOUND') {
          isResolved = true;
          message = this.main.locale.getMessage('channelDontExist');
        } else {
          message = 'Unexpected error';
        }
        await this.main.bot.editMessageText(message, {
          chat_id: req.chatId,
          message_id: req.messageId
        });
        if (!isResolved) {
          throw err;
        }
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/delete/, provideChannels, withChannels, (req: RouterReqWithChannels, res) => {
      const channels = req.channels.map((channel) => {
        return [{
          text: channel.title,
          callback_data: `/delete/${channel.id}`
        }];
      });

      const page = pageBtnList(req.query, channels, '/delete', {
        text: 'Cancel',
        callback_data: '/cancel/delete'
      });

      return promiseTry(() => {
        if (req.callback_query && !req.query.rel) {
          return this.main.bot.editMessageReplyMarkup(JSON.stringify({
            inline_keyboard: page
          }), {
            chat_id: req.chatId,
            message_id: req.messageId
          }).catch((err: any) => {
            if (/message is not modified/.test(err.message)) {
              // pass
            } else {
              throw err;
            }
          });
        } else {
          return this.main.bot.sendMessage(req.chatId, this.main.locale.getMessage('selectDelChannel'), {
            reply_markup: JSON.stringify({
              inline_keyboard: page
            })
          });
        }
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.callback_query(/\/deleteChannel/, provideChat, (req: RouterReqWithChat, res) => {
      return promiseTry(() => {
        return this.main.db.deleteChatById(req.chat.channelId);
      }).then(() => {
        return this.main.bot.editMessageReplyMarkup(JSON.stringify({
          inline_keyboard: getOptions(req.chat)
        }), {
          chat_id: req.chatId,
          message_id: req.messageId
        }).catch((err: any) => {
          if (/message is not modified/.test(err.message)) {
            return;
          }
          throw err;
        });
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/setChannel(?:\s+(?<channelId>.+))?/, provideChat, (req: RouterReqWithChat, res) => {
      const channelId = req.params.channelId;
      let requestedData: string = null;

      return promiseTry(() => {
        if (channelId) {
          return {channelId: channelId.trim(), messageId: undefined};
        }

        const messageText = this.main.locale.getMessage('telegramChannelEnter');
        const cancelText = this.main.locale.getMessage('commandCanceled').replace('{command}', '\/setChannel');
        return requestData(req.chatId, req.fromId, messageText, cancelText).then(({req, msg}) => {
          requestedData = req.message.text;
          this.main.tracker.track(req.chatId, {
            ec: 'command',
            ea: '/setChannel',
            el: req.message.text,
            t: 'event'
          });
          return {channelId: req.message.text.trim(), messageId: msg.message_id};
        });
      }).then(({channelId, messageId}: {channelId: string, messageId?: number}) => {
        return promiseTry(() => {
          if (!/^@\w+$/.test(channelId)) {
            throw new ErrorWithCode('Incorrect channel name', 'INCORRECT_CHANNEL_NAME');
          }

          return this.main.db.getChatById(channelId).then((chat) => {
            throw new ErrorWithCode('Channel already used', 'CHANNEL_ALREADY_USED');
          }, (err: any) => {
            if (err.code === 'CHAT_IS_NOT_FOUND') {
              // pass
            } else {
              throw err;
            }
          }).then(() => {
            return this.main.bot.sendChatAction(channelId, 'typing').then(() => {
              return this.main.bot.getChat(channelId).then((chat: TChat) => {
                if (chat.type !== 'channel') {
                  throw new ErrorWithCode('This chat type is not supported', 'INCORRECT_CHAT_TYPE');
                }
                const channelId = '@' + chat.username;
                return this.main.db.createChatChannel('' + req.chatId, channelId).then(() => channelId);
              });
            });
          });
        }).then((channelId) => {
          const message = this.main.locale.getMessage('telegramChannelSet').replace('{channelName}', channelId);
          return editOrSendNewMessage(req.chatId, messageId, message).then(() => {
            if (req.callback_query) {
              return this.main.bot.editMessageReplyMarkup(JSON.stringify({
                inline_keyboard: getOptions(req.chat)
              }), {
                chat_id: req.chatId,
                message_id: req.messageId
              }).catch((err: any) => {
                if (/message is not modified/.test(err.message)) {
                  return;
                }
                throw err;
              });
            }
          });
        }, async (err) => {
          let isResolved = false;
          let message = null;
          if (['INCORRECT_CHANNEL_NAME', 'CHANNEL_ALREADY_USED', 'INCORRECT_CHAT_TYPE'].includes(err.code)) {
            isResolved = true;
            message = err.message;
          } else
          if (err.code === 'ETELEGRAM' && /chat not found/.test(err.message)) {
            isResolved = true;
            message = 'Telegram chat is not found!';
          } else
          if (err.code === 'ETELEGRAM' && /bot is not a member of the/.test(err.message)) {
            isResolved = true;
            message = 'Bot is not a member of the channel!';
          } else {
            message = 'Unexpected error';
          }
          await editOrSendNewMessage(req.chatId, req.messageId, message);
          if (!isResolved) {
            throw err;
          }
        });
      }).catch((err: any) => {
        if (['RESPONSE_COMMAND', 'RESPONSE_TIMEOUT'].includes(err.code)) {
          // pass
        } else {
          debug('%j %j error %o', req.command, requestedData, err);
        }
      });
    });

    this.router.callback_query(/\/(?<optionsType>options|channelOptions)\/(?<key>[^\/]+)\/(?<value>.+)/, provideChat, (req: RouterReqWithChat, res) => {
      const {optionsType, key, value} = req.params;
      return promiseTry(() => {
        const changes: {[s: string]: any} = {};
        switch (key) {
          case 'isHidePreview': {
            changes.isHidePreview = value === 'true';
            break;
          }
          case 'isMutedRecords': {
            if (optionsType === 'channelOptions') {
              throw new ErrorWithCode('Option is not available for channel', 'UNAVAILABLE_CHANNEL_OPTION');
            }
            changes.isMutedRecords = value === 'true';
            break;
          }
          case 'isEnabledAutoClean': {
            changes.isEnabledAutoClean = value === 'true';
            break;
          }
          case 'isMuted': {
            if (optionsType === 'channelOptions') {
              throw new ErrorWithCode('Option is not available for channel', 'UNAVAILABLE_CHANNEL_OPTION');
            }
            changes.isMuted = value === 'true';
            break;
          }
          default: {
            throw new Error('Unknown option filed');
          }
        }
        switch (optionsType) {
          case 'options': {
            Object.assign(req.chat, changes);
            return req.chat.save();
          }
          case 'channelOptions': {
            Object.assign(req.chat.channel, changes);
            return req.chat.channel.save();
          }
        }
      }).then(() => {
        return this.main.bot.editMessageReplyMarkup(JSON.stringify({
          inline_keyboard: getOptions(req.chat)
        }), {
          chat_id: req.chatId,
          message_id: req.messageId
        }).catch((err: any) => {
          if (/message is not modified/.test(err.message)) {
            return;
          }
          throw err;
        });
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/options/, provideChat, (req: RouterReqWithChat, res) => {
      return promiseTry(() => {
        if (req.callback_query && !req.query.rel) {
          return this.main.bot.editMessageReplyMarkup(JSON.stringify({
            inline_keyboard: getOptions(req.chat)
          }), {
            chat_id: req.chatId,
            message_id: req.messageId
          });
        } else {
          return this.main.bot.sendMessage(req.chatId, 'Options:', {
            reply_markup: JSON.stringify({
              inline_keyboard: getOptions(req.chat)
            })
          });
        }
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/online/, provideChannels, withChannels, (req: RouterReqWithChannels, res) => {
      const channelIds = req.channels.map(channel => channel.id);
      return this.main.db.getStreamsWithChannelByChannelIds(channelIds).then((streams) => {
        let message: string = null;
        if (!streams.length){
          message = this.main.locale.getMessage('offline');
        } else {
          message = streams.map(stream => getString(stream)).join('\n\n');
        }

        const buttons: TInlineKeyboardButton[][] = [];
        streams.forEach((stream) => {
          if (!stream.isOffline && !stream.isTimeout) {
            buttons.push([{
              text: getButtonText(stream),
              callback_data: `/watch/${stream.id}`
            }]);
          }
        });

        const buttonsPage = pageBtnList(req.query, buttons, '/online');

        buttonsPage.unshift([{
          text: this.main.locale.getMessage('refresh'),
          callback_data: '/online'
        }]);

        const options = {
          disable_web_page_preview: true,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({
            inline_keyboard: buttonsPage
          })
        };

        return promiseTry(() => {
          if (req.callback_query && !req.query.rel) {
            return this.main.bot.editMessageText(message, Object.assign(options, {
              chat_id: req.chatId,
              message_id: req.messageId,
            }));
          } else {
            return this.main.bot.sendMessage(req.chatId, message, options);
          }
        });
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.callback_query(/\/watch\/(?<streamId>.+)/, provideChat, (req: RouterReqWithChat, res) => {
      const {streamId} = req.params;
      return this.main.db.getStreamWithChannelById(streamId).then((stream) => {
        const chatSender = new ChatSender(this.main, req.chat);
        return chatSender.sendStream(stream);
      }, (err) => {
        if (err.code === 'STREAM_IS_NOT_FOUND') {
          const message = this.main.locale.getMessage('streamIsNotFound');
          return this.main.bot.sendMessage(req.chatId, message);
        }
        throw err;
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/list/, provideChannels, withChannels, (req: RouterReqWithChannels, res) => {
      const serviceIds: string[] = [];
      const serviceIdChannels: Map<string, IChannel[]> = new Map();
      req.channels.forEach((channel: IChannel) => {
        if (!serviceIdChannels.has(channel.service)) {
          serviceIds.push(channel.service);
        }
        const serviceChannels = ensureMap(serviceIdChannels, channel.service, []);
        serviceChannels.push(channel);
      });

      serviceIds.sort((aa, bb) => {
        const a = serviceIdChannels.get(aa).length;
        const b = serviceIdChannels.get(bb).length;
        return a === b ? 0 : a > b ? -1 : 1;
      });

      const lines: string[] = [];
      serviceIds.forEach((serviceId) => {
        const channelLines = [];
        const service = this.main.getServiceById(serviceId);
        channelLines.push(htmlSanitize('b', service.name + ':'));
        serviceIdChannels.get(serviceId).forEach((channel) => {
          channelLines.push(htmlSanitize('a', channel.title, channel.url));
        });
        lines.push(channelLines.join('\n'));
      });

      const body = lines.join('\n\n');
      const pageIndex = parseInt(req.query.page || 0);
      const pages = splitTextByPages(body);
      const prevPages = pages.splice(0, pageIndex);
      const pageText = pages.shift() || prevPages.shift();

      const pageControls = [];
      if (pageIndex > 0) {
        pageControls.push({
          text: '<',
          callback_data: '/list' + '?page=' + (pageIndex - 1)
        });
      }
      if (pages.length) {
        pageControls.push({
          text: '>',
          callback_data: '/list' + '?page=' + (pageIndex + 1)
        });
      }

      const options = {
        disable_web_page_preview: true,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({
          inline_keyboard: [pageControls]
        })
      };

      return promiseTry(() => {
        if (req.callback_query && !req.query.rel) {
          return this.main.bot.editMessageText(pageText, Object.assign(options, {
            chat_id: req.chatId,
            message_id: req.messageId,
          }));
        } else {
          return this.main.bot.sendMessage(req.chatId, pageText, options);
        }
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    const requestData = (chatId: number, fromId: number, messageText: string, cancelText: string): Promise<{
      req: RouterReq, msg: TMessage
    }> => {
      const options: {[s: string]: any} = {};
      let msgText = messageText;
      if (chatId < 0) {
        msgText += this.main.locale.getMessage('groupNote');
        options.reply_markup = JSON.stringify({
          force_reply: true
        });
      }

      return this.main.bot.sendMessage(chatId, msgText, options).then((msg: TMessage) => {
        return this.router.waitResponse({
          event: 'message',
          type: 'text',
          chatId: chatId,
          fromId: fromId,
          throwOnCommand: true
        }, 3 * 60).then(({req, res, next}) => {
          return {req, msg};
        }, async (err) => {
          if (['RESPONSE_COMMAND', 'RESPONSE_TIMEOUT'].includes(err.code)) {
            await editOrSendNewMessage(chatId, msg.message_id, cancelText);
          }
          throw err;
        });
      });
    };

    const requestChoose = (chatId: number, fromId: number, messageId: number, messageText: string, cancelText: string, inline_keyboard: TInlineKeyboardButton[][]): Promise<{
      req: RouterReq, msg: TMessage
    }> => {
      return editOrSendNewMessage(chatId, messageId, messageText, {
        reply_markup: JSON.stringify({inline_keyboard})
      }).then((msg) => {
        return this.router.waitResponse(/\/choose\/(?<value>.+)/, {
          event: 'callback_query',
          chatId: chatId,
          fromId: fromId,
        }, 3 * 60).then(({req, res, next}) => {
          return this.main.bot.answerCallbackQuery(req.callback_query.id).then(async () => {
            if (req.params.value === 'cancel') {
              await editOrSendNewMessage(chatId, msg.message_id, cancelText);
              throw new ErrorWithCode('Response cancel', 'RESPONSE_CANCEL');
            }
            return {req, msg};
          });
        }, async (err) => {
          if (['RESPONSE_COMMAND', 'RESPONSE_TIMEOUT'].includes(err.code)) {
            await editOrSendNewMessage(chatId, msg.message_id, cancelText);
          }
          throw err;
        });
      });
    };

    const editOrSendNewMessage = (chatId: number, messageId: number|undefined, text: string, form?: object) => {
      return promiseTry(() => {
        if (!messageId) {
          throw new ErrorWithCode('messageId is empty', 'MESSAGE_ID_IS_EMPTY');
        }

        return this.main.bot.editMessageText(text, Object.assign({}, form, {
          chat_id: chatId,
          message_id: messageId,
        }));
      }).catch((err) => {
        if (
          err.code === 'MESSAGE_ID_IS_EMPTY' ||
          /message can't be edited/.test(err.message) ||
          /message to edit not found/.test(err.message)
        ) {
          return this.main.bot.sendMessage(chatId, text, form);
        }
        throw err;
      });
    };
  }

  admin() {
    const isAdmin = (req: RouterReq, res: RouterRes, next: () => void) => {
      const adminIds = this.main.config.adminIds || [];
      if (adminIds.includes(req.chatId)) {
        next();
      } else {
        this.main.bot.sendMessage(req.chatId, `Access denied for you (${req.chatId})`);
      }
    };

    const commands = [
      {name: 'Check chats exists', method: 'sender.checkChatsExists'},
      {name: 'Check channels exists', method: 'checker.checkChannelsExists'},
      {name: 'Check channels', method: 'checker.check'},
      {name: 'Clean chats & channels', method: 'checker.clean'},
      {name: 'Sender check', method: 'sender.check'},
    ];

    this.router.callback_query(/\/admin\/(?<command>.+)/, isAdmin, (req, res) => {
      const command = req.params.command;
      return promiseTry(() => {
        if (!commands.some(({method}) => method === command)) {
          throw new ErrorWithCode('Method is not found', 'METHOD_IS_NOT_FOUND');
        }
        const {scope, endPoint} = resolvePath(this.main, command);
        // @ts-ignore
        return scope[endPoint].call(scope);
      }).then((result) => {
        const resultStr = jsonStringifyPretty({result}, {
          indent: 2
        });
        return this.main.bot.sendMessage(req.chatId, `${command} complete!\n${resultStr}`);
      }, async (err) => {
        await this.main.bot.sendMessage(req.chatId, `${command} error!`);
        throw err;
      }).catch((err) => {
        debug('%j error %o', req.command, err);
      });
    });

    this.router.textOrCallbackQuery(/\/admin/, isAdmin, (req, res) => {
      return this.main.bot.sendMessage(req.chatId, 'Admin menu', {
        reply_markup: JSON.stringify({
          inline_keyboard: commands.reduce((menu, {name, method}, index) => {
            const buttons = index % 2 ? menu.pop() : [];
            buttons.push({
              text: name || method,
              callback_data: `/admin/${method}`
            });
            menu.push(buttons);
            return menu;
          }, [])
        })
      }).catch((err: any) => {
        debug('%j error %o', req.command, err);
      });
    });
  }
}

function getMenu(page: number) {
  let menu = null;
  if (page > 0) {
    menu = [
      [
        {
          text: 'Options',
          callback_data: '/options?rel=menu'
        }
      ],
      [
        {
          text: '<',
          callback_data: '/menu'
        },
        {
          text: 'Top 10',
          callback_data: '/top'
        },
        {
          text: 'About',
          callback_data: '/about'
        }
      ]
    ];
  } else {
    menu = [
      [
        {
          text: 'Online',
          callback_data: '/online?rel=menu'
        },
        {
          text: 'Show the channel list',
          callback_data: '/list?rel=menu'
        }
      ],
      [
        {
          text: 'Add channel',
          callback_data: '/add'
        },
        {
          text: 'Delete channel',
          callback_data: '/delete?rel=menu'
        },
        {
          text: '>',
          callback_data: '/menu/1'
        }
      ]
    ];
  }

  return menu;
}

function getOptions(chat: IChatWithChannel) {
  const btnList = [];

  if (chat.isHidePreview) {
    btnList.push([{
      text: 'Show preview',
      callback_data: '/options/isHidePreview/false'
    }]);
  } else {
    btnList.push([{
      text: 'Hide preview',
      callback_data: '/options/isHidePreview/true'
    }]);
  }

  if (chat.isMutedRecords) {
    btnList.push([{
      text: 'Unmute records',
      callback_data: '/options/isMutedRecords/false'
    }]);
  } else {
    btnList.push([{
      text: 'Mute records',
      callback_data: '/options/isMutedRecords/true'
    }]);
  }

  if (chat.isEnabledAutoClean) {
    btnList.push([{
      text: `Don't remove messages`,
      callback_data: '/options/isEnabledAutoClean/false'
    }]);
  } else {
    btnList.push([{
      text: 'Remove messages after 24h',
      callback_data: '/options/isEnabledAutoClean/true'
    }]);
  }

  if (chat.channelId) {
    btnList.push([{
      text: 'Remove channel (' + chat.channelId + ')',
      callback_data: '/deleteChannel',
    }]);
  } else {
    btnList.push([{
      text: 'Set channel',
      callback_data: '/setChannel',
    }]);
  }

  if (chat.channelId) {
    if (chat.isMuted) {
      btnList.push([{
        text: 'Unmute this chat',
        callback_data: '/options/isMuted/false'
      }]);
    } else {
      btnList.push([{
        text: 'Mute this chat',
        callback_data: '/options/isMuted/true'
      }]);
    }
  }

  if (chat.channel) {
    if (chat.channel.isHidePreview) {
      btnList.push([{
        text: 'Show preview for channel',
        callback_data: '/channelOptions/isHidePreview/false'
      }]);
    } else {
      btnList.push([{
        text: 'Hide preview for channel',
        callback_data: '/channelOptions/isHidePreview/true'
      }]);
    }

    if (chat.isEnabledAutoClean) {
      btnList.push([{
        text: `Don't remove messages for channel`,
        callback_data: '/channelOptions/isEnabledAutoClean/false'
      }]);
    } else {
      btnList.push([{
        text: 'Remove messages after 24h for channel',
        callback_data: '/channelOptions/isEnabledAutoClean/true'
      }]);
    }
  }

  return btnList;
}

export default Chat;