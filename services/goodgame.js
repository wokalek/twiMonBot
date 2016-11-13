/**
 * Created by anton on 19.07.15.
 */
var debug = require('debug')('goodgame');
var base = require('../base');
var Promise = require('bluebird');
var request = require('request');
var requestPromise = Promise.promisify(request);
var CustomError = require('../customError').CustomError;

var GoodGame = function (options) {
    "use strict";
    var _this = this;
    this.gOptions = options;
    this.config = {};

    this.onReady = base.storage.get(['ggChannelInfo']).then(function(storage) {
        _this.config.channelInfo = storage.ggChannelInfo || {};
    });
};

GoodGame.prototype.saveChannelInfo = function () {
    "use strict";
    return base.storage.set({
        ggChannelInfo: this.config.channelInfo
    });
};

GoodGame.prototype.getChannelInfo = function (channelId) {
    "use strict";
    var obj = this.config.channelInfo[channelId];
    if (!obj) {
        obj = this.config.channelInfo[channelId] = {};
    }
    return obj;
};

GoodGame.prototype.removeChannelInfo = function (channelId) {
    "use strict";
    delete this.config.channelInfo[channelId];
    return this.saveChannelInfo();
};

GoodGame.prototype.setChannelTitle = function (channelId, title) {
    "use strict";
    if (channelId === title) {
        return Promise.resolve();
    }
    var info = this.getChannelInfo(channelId);
    if (info.title !== title) {
        info.title = title;
        return this.saveChannelInfo();
    }
};

GoodGame.prototype.getChannelTitle = function (channelId) {
    "use strict";
    var info = this.getChannelInfo(channelId);
    return info.title || channelId;
};

GoodGame.prototype.clean = function(channelIdList) {
    "use strict";
    var _this = this;
    var promiseList = [];

    var needSaveState = false;
    var channelInfo = _this.config.channelInfo;
    Object.keys(channelInfo).forEach(function (channelId) {
        if (channelIdList.indexOf(channelId) === -1) {
            delete channelInfo[channelId];
            needSaveState = true;
            // debug('Removed from channelInfo %s', channelId);
        }
    });

    if (needSaveState) {
        promiseList.push(_this.saveChannelInfo());
    }

    return Promise.all(promiseList);
};

var noProtocolRe = /^\/\//;

GoodGame.prototype.apiNormalization = function (data) {
    "use strict";
    var _this = this;

    var now = base.getNow();
    var streamArray = [];
    data._embedded.streams.forEach(function (origItem) {
        if (origItem.status !== 'Live') {
            return;
        }

        if (!origItem.key || !origItem.id || !origItem.channel) {
            debug('Skip item! %j', origItem);
            return;
        }

        var id = origItem.id;
        var viewers = parseInt(origItem.viewers) || 0;
        var name = origItem.key;
        var channelId = name.toLowerCase();
        var channel = origItem.channel;

        var previewList = [];
        if (channel.thumb) {
            previewList.push(channel.thumb.replace(/_240(\.jpg)$/, '$1'));
            previewList.push(channel.thumb);
        }
        previewList = previewList.map(function(url) {
            if (noProtocolRe.test(url)) {
                url = 'http:' + url;
            }
            return base.noCacheUrl(url);
        });

        var game = channel.games && channel.games[0];
        if (game) {
            game = game.title;
        }

        var item = {
            _service: 'goodgame',
            _checkTime: now,
            _insertTime: now,
            _id: 'g' + id,
            _isOffline: false,
            _isTimeout: false,
            _channelId: channelId,

            viewers: viewers,
            game: game,
            preview: previewList,
            created_at: undefined,
            channel: {
                name: name,
                status: channel.title,
                url: channel.url
            }
        };

        _this.setChannelTitle(channelId, name);

        streamArray.push(item);
    });
    return streamArray;
};

GoodGame.prototype.getStreamList = function (channelList) {
    "use strict";
    var _this = this;
    var videoList = [];

    var promiseList = base.arrToParts(channelList, 25).map(function (arr) {
        var retryLimit = 5;
        var getList = function () {
            return requestPromise({
                method: 'GET',
                url: 'https://api2.goodgame.ru/v2/streams',
                qs: {
                    ids: arr.join(','),
                    adult: true,
                    hidden: true
                },
                headers: {
                    'Accept': 'application/vnd.goodgame.v2+json'
                },
                json: true,
                gzip: true,
                forever: true
            }).then(function(response) {
                if (response.statusCode === 500) {
                    throw new CustomError(response.statusCode);
                }

                if (response.statusCode !== 200) {
                    debug('Unexpected response %j', response);
                    throw new CustomError('Unexpected response');
                }

                return response;
            }).catch(function (err) {
                retryLimit--;
                if (retryLimit > 0) {
                    return new Promise(function(resolve) {
                        return setTimeout(resolve, 250);
                    }).then(function() {
                        // debug("Retry %s getList", retryLimit, err);
                        return getList();
                    });
                }

                throw err;
            });
        };

        return getList().then(function (response) {
            var responseBody = response.body;
            try {
                var list = _this.apiNormalization(responseBody);
                videoList.push.apply(videoList, list);
            } catch (e) {
                debug('Unexpected response %j', response, e);
                throw new CustomError('Unexpected response');
            }
        }).catch(function (err) {
            arr.forEach(function (channelId) {
                videoList.push(base.getTimeoutStream('goodgame', channelId));
            });
            debug("Request stream list error!", err);
        });
    });

    return Promise.all(promiseList).then(function () {
        return videoList;
    });
};

GoodGame.prototype.getChannelId = function (channelName) {
    "use strict";
    var _this = this;
    return requestPromise({
        method: 'GET',
        url: 'https://api2.goodgame.ru/v2/streams/' + encodeURIComponent(channelName),
        headers: {
            'Accept': 'application/vnd.goodgame.v2+json'
        },
        json: true,
        gzip: true,
        forever: true
    }).then(function (response) {
        if (response.statusCode === 404) {
            throw new CustomError(response.statusCode);
        }

        if (response.statusCode !== 200) {
            debug('Unexpected response %j', response);
            throw new CustomError(response.statusCode);
        }

        var responseJson = response.body;

        var channelId = responseJson.key;
        if (!channelId) {
            throw new CustomError('Channel is not found!');
        }

        channelId = channelId.toLowerCase();
        return _this.setChannelTitle(channelId, responseJson.key).then(function () {
            return channelId;
        });
    });
};

module.exports = GoodGame;