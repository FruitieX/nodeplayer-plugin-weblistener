var queue = [];
var queueTruncated = false;
var searchResults = {};
var progress = {progress: 0, interval: null};
var paused = true;

var currentSong = {};
var currentProgress;
var streaming = false;

var retryAfterLogin = _.noop;

var verifySong = function(song) {
    if (!song.albumArt) {
        song.albumArt = {};
    }
    if (!song.albumArt.lq) {
        song.albumArt.lq = 'media/NoAlbumArt.png';
    }
};

var search = function() {
    var searchTerms = $('#search-terms').val();
    $('#search-button').prop('disabled', true);

    $.ajax({
        type: 'POST',
        url: '/search',
        data: JSON.stringify({
            terms: searchTerms
            //pageToken: 0 // don't use unless you really want a specific page
        }),
        contentType: 'application/json'
    })
    .error(function(res) {
        if (res.status === 403) {
            retryAfterLogin = search;
            $('#loginError').empty();
            $('#loginModal').modal();
        } else {
            console.error(res);
        }
    })
    .done(function(data) {
        searchResults = JSON.parse(data);
        $('#search-results').empty();
        $('#search-results-text').removeClass('hidden');
        $('#search-remove').removeClass('hidden');
        $('#search-button').prop('disabled', false);

        // TODO: separate backends somehow
        // right now we just sort songs by score
        var songs = [];
        _.each(_.pluck(searchResults, 'songs'), function(backendSongs) {
            _.each(backendSongs, function(song) {
                songs.push(song);
            });
        });
        songs = _.sortBy(songs, 'score').reverse();
        _.each(songs, function(song) {
            verifySong(song);
            $.tmpl('searchTemplate', {
                title: song.title,
                artist: song.artist,
                album: song.album,
                albumArt: song.albumArt,
                duration: durationToString(song.duration / 1000),
                songID: song.songID,
                backendName: song.backendName
            }).appendTo('#search-results');
        });
        /*
            var songsInOrder = _.sortBy(searchResults[backendName].songs, 'score');
            _.each(songsInOrder, function(songID) {
                var song = searchResults[backendName].songs[songID];
            });
        });
        // TODO: pagination using backendResults.next/prevPageToken
        if (searchResults.length > resultsCount) {
            $.tmpl( 'ellipsisTemplate', {
        */
    }).fail(function() {
        $('#search-button').prop('disabled', false);
    });
};

var appendQueue = function(backendName, songID) {
    if (songID !== 0 && !songID) { return; }
    if (!backendName) { return; }
    searchResults[backendName].songs[songID].userID = $.cookie('userID');
    $.ajax({
        type: 'POST',
        url: '/queue/add',
        data: JSON.stringify({
            songs: [searchResults[backendName].songs[songID]]
        }),
        contentType: 'application/json'
    });

    $('#search-results').empty();
    $('#search-results-text').addClass('hidden');
    $('#search-remove').addClass('hidden');
};

var searchRemove = function() {
    $('#search-results').empty();
    $('#search-results-text').addClass('hidden');
    $('#search-remove').addClass('hidden');
};

var socket = io();
socket.on('queue', function(data) {
    queue = data.items;
    _.each(queue, function(song) {
        verifySong(song);
    });
    queueTruncated = (data.length > data.items.length);
    updateQueue();
});

socket.on('volume', function(data) {
    if (data.userID === $.cookie('userID')) { return; }
    $('#volume').val(data.volume);
    $('#audio')[0].volume = data.volume;
});
var setVolume = _.throttle(function(volume) {
    saveEmit('setVolume', {
        userID: $.cookie('userID'),
        volume: volume
    });
}, 100);

socket.on('invalidCredentials', function() {
    retryAfterLogin = function() {
        if (savedEmit.event) {
            saveEmit(savedEmit.event, savedEmit.data);
        }
        savedEmit = {};
    };

    console.log('invalid passport.socketio credentials!');
    $('#loginError').empty();
    $('#loginModal').modal();
});

var savedEmit = {};
var saveEmit = function(event, data) {
    savedEmit.event = event;
    savedEmit.data = data;
    socket.emit(event, data);
};

var startPlayback = function(forceSkip) {
    if (!currentSong.backendName ||
        !currentSong.songID ||
        !currentSong.format) {
        console.error('currentSong is lacking required properties:', currentSong);
        return;
    }

    var audio = $('#audio');
    var url = '/song/' + currentSong.backendName + '/' +
        currentSong.songID + '.' + currentSong.format;

    audio.attr('src', url);

    audio.off('loadedmetadata');
    audio.on('loadedmetadata', function() {
        // don't seek if position is zero to avoid skips at start of song,
        // however, do skip if we eg. just started streaming
        if (currentSong.position || forceSkip) {
            var pos = currentSong.position / 1000 +
                (new Date().getTime() - currentSong.playbackStart) / 1000;
            console.info('seeking to ' + pos);
            this.currentTime = pos;
        }
    });
    audio.off('error');
    audio.on('error', function(e) {
        // FIXME: stupid way of figuring out if the error was a 403,
        // but is there even a better way?
        $.ajax({
            url: url,
            headers: {Range: "bytes=0-1"},
            success: function( data ) {
                $('#results').html( data );
            }
        })
        .done(function(data) {
            console.error('AJAX request worked, player request did not, retrying...', e);
            setTimeout(function() {startPlayback();}, 1000);
        })
        .error(function(res) {
            if (res.status === 403) {
                retryAfterLogin = startPlayback;
                $('#loginError').text(res.responseText);
                $('#loginModal').modal();
            } else {
                console.error('Unknown error while streaming, retrying...', e);
                setTimeout(function() {startPlayback();}, 1000);
            }
        });
    });
};

socket.on('playback', function(data) {
    currentSong = data || {};
    if (!data || !data.playbackStart) {
        currentSong.playbackStart = new Date().getTime();
        $('#audio').trigger('pause');
        paused = true;
        $('#playpauseicon').removeClass('glyphicon-pause glyphicon-play');
        $('#playpauseicon').addClass('glyphicon-play');

        clearInterval(progress.interval);
        if (data) {
            currentProgress = (data.position || 0);
            progress.started = new Date().getTime() - currentProgress;
            progress.duration = data.duration;
        }
    } else {
        currentSong.playbackStart = new Date().getTime();
        paused = false;
        $('#playpauseicon').removeClass('glyphicon-pause glyphicon-play');
        $('#playpauseicon').addClass('glyphicon-pause');

        // volume update
        $('#volume').val(data.volume);
        $('#audio')[0].volume = data.volume;

        currentProgress = (data.position || 0);
        progress.started = new Date() - currentProgress;
        progress.duration = data.duration;

        clearInterval(progress.interval);
        if (data.playbackStart) {
            progress.interval = setInterval(function() {
                updateProgress(100);
            }, 100);
        }

        if (streaming) {
            startPlayback(false);
        }
    }
});

var pad = function(number, length) {
    var str = '' + number;

    while (str.length < length) {
        str = '0' + str;
    }

    return str;
};

// UI
var updateProgress = function(dt) { // dt = ms passed since last call
    if (!queue[0]) {
        clearInterval(progress.interval);
        return;
    }

    var currentProgress = new Date() - progress.started;
    $('#progress').css('width', 100 * (currentProgress / progress.duration) + '%');
    if (currentProgress > progress.duration) {
        $('#progress').css('width', '100%');
    }
};

var updateQueue = function() {
    $('#queue').empty();

    if (queue) {
        // now playing
        if (queue[0]) {
            queue[0].durationString = durationToString(queue[0].duration / 1000);
            $.tmpl('nowPlayingTemplate', queue[0]).appendTo('#queue');
            updateProgress(0);
            $('#nowplaying').click(function(e) {
                var posX = e.pageX - $(this).offset().left;
                saveEmit('startPlayback', (posX / $(this).outerWidth()) * queue[0].duration);
            });
            $('#nowplaying').mousemove(function(e) {
                var posX = e.pageX - $(this).offset().left;
                $('#progressmouseover').css('width', 100 * (posX / $(this).outerWidth()) + '%');
            });
            $('#nowplaying').hover(function(e) {
                $('#progressmouseover').css('visibility', 'visible');
            }, function(e) {
                $('#progressmouseover').css('visibility', 'hidden');
            });
            $('#remove0').mousemove(function(e) {
                $('#progressmouseover').css('visibility', 'hidden');
                e.stopPropagation();
            });
            $('#remove0').hover(function(e) {
                // TODO: this is a bit stupid?
                $('#progressmouseover').css('visibility', 'visible');
            });
            $('#remove0').click(function(e) {
                removeFromQueue(0);
                e.stopPropagation();
            });
        }

        var onRemoveClick = function(e) {
            removeFromQueue(i, queue.backendName + queue.songID);
            e.stopPropagation();
        };

        // rest of queue
        var removeOnClick = function(index) {
            $('#remove' + index).click(function(e) {
                removeFromQueue(index);
                e.stopPropagation();
            });
        };
        var queueOnClick = function(index) {
            $('#queue' + index).dblclick(function(e) {
                skipSongs(index);
                e.stopPropagation();
            });
        };
        var thumbnailOnClick = function(index) {
            $('#thumbnail-overlay' + index).click(function(e) {
                skipSongs(index);
                e.stopPropagation();
            });
        };
        var thumbnailOnMouseenter = function(index) {
            $('#queue' + index).mouseenter(function(e) {
                $('#thumbnail-overlay' + index).show();
                e.stopPropagation();
            });
        };
        var thumbnailOnMouseleave = function(index) {
            $('#queue' + index).mouseleave(function(e) {
                $('#thumbnail-overlay' + index).hide();
                e.stopPropagation();
            });
        };
        for (var i = 1; i < queue.length; i++) {
            queue[i].durationString = durationToString(queue[i].duration / 1000);
            queue[i].pos = i;
            $.tmpl('queueTemplate', queue[i]).appendTo('#queue');
            queueOnClick(i);
            removeOnClick(i);
            $('#thumbnail-overlay' + i).hide();
            thumbnailOnClick(i);
            thumbnailOnMouseenter(i);
            thumbnailOnMouseleave(i);
        }
        if (queueTruncated) {
            $.tmpl('queueTruncated').appendTo('#queue');
        }
    }
};

var durationToString = function(seconds) {
    var durationString = Math.floor(seconds / 60);
    durationString += ':' + pad(Math.floor(seconds % 60), 2);
    return durationString;
};

var removeFromQueue = function(pos, id) {
    saveEmit('removeFromQueue', {
        pos: pos
    });
    $(document.getElementById(id)).css('background-color', '#fee');
};

var skipSongs = function(cnt) {
    saveEmit('skipSongs', cnt);
};

var updateLogin = function(callback, reconnectIO) {
    if ($.cookie('username')) {
        $('#auth-text').html('Logged in as: <b id="username"></b> ' +
            '(<a href="/logout">Log out</a>)');
        $('#username').text($.cookie('username'));
    }
    if (reconnectIO) {
        socket.disconnect();
        socket.connect();
        socket.once('connect', function() {
            callback();
        });
    } else if (callback) {
        callback();
    }
};

$(document).ready(function() {
    // generate a user ID if there is not one yet
    if (!$.cookie('userID')) {
        var s4 = function() {
            return Math.floor((1 + Math.random()) * 0x10000)
                .toString(16)
                .substring(1);
        };
        var guid = s4() + s4() + '-' + s4() + '-' + s4() + '-' +
                s4() + '-' + s4() + s4() + s4();
        $.cookie('userID', guid);
    }

    var nowPlayingMarkup =
        '<li class="list-group-item now-playing" id="nowplaying">' +

        '<div class="right fullHeight">' +
        '<div class="remove glyphicon glyphicon-remove" id="remove0"></div>' +
        '<div class="duration-container"><div class="duration">${durationString}</div></div>' +
        '</div>' +

        '<div class="thumbnail"><img src=${albumArt.lq} /></div>' +
        '<div id="progressmouseover"></div>' +
        '<div id="progress"></div>' +
        '<div class="np-songinfo">' +
        '<div class="big"><b>${title}</b></div>' +
        '<div class="small"><b>${artist}</b> (${album})</div>' +
        '</div>' +
        '</li>';

    $.template('nowPlayingTemplate', nowPlayingMarkup);

    var searchResultMarkup =
        '<li class="list-group-item searchResult" id="${backendName}${songID}"' +
            'onclick="appendQueue(\'${backendName}\', \'${songID}\')">' +

        '<div class="duration-container"><div class="duration">${duration}</div></div>' +

        '<div class="thumbnail"><img src=${albumArt.lq} /></div>' +
        '<div class="big"><b>${title}</b></div>' +
        '<div class="small"><b>${artist}</b> (${album})</div>' +
        '</li>';

    $.template('searchTemplate', searchResultMarkup);

    var ellipsisResultMarkup =
        '<li class="list-group-item searchResult" id="${backendName}${songID}">' +
        '<div class="big">${title}</div>' +
        '</li>';

    $.template('ellipsisTemplate', ellipsisResultMarkup);

    $('#search-terms').keyup(function(e) {
        if (e.keyCode === 13) {
            search();
        }
    });

    var queueMarkup =
        '<li class="list-group-item queue-item" id="queue${pos}">' +
            //'onclick="skipSongs(\'${pos}\');">' +

        '<div class="right fullHeight">' +
        '<div class="remove glyphicon glyphicon-remove" id="remove${pos}"></div>' +
        '<div class="duration-container"><div class="duration">${durationString}</div></div>' +
        '</div>' +

        '<div class="thumbnail" id="thumbnail${pos}"><img src=${albumArt.lq} /></div>' +

        '<div class="thumbnail-overlay" id="thumbnail-overlay${pos}">' +
        '<img src="media/thumbnail-overlay.png" /></div>' +

        '<div class="songinfo">' +
        '<div class="big"><b>${title}</b></div>' +
        '<div class="small"><b>${artist}</b> (${album})</div>' +
        '</div>' +
        '</li>';

    $.template('queueTemplate', queueMarkup);

    var queueTruncatedMarkup = '<li class="list-group-item queue-item">' +
    '<div class="songinfo">' +
    '<div class="big"><b>...</b></div>' +
    '</div>' +
    '</li>';

    $.template('queueTruncated', queueTruncatedMarkup);

    var preMuteVolume;
    var setVolumeIcon = function() {
        var volume = $('#audio')[0].volume;
        $('#muteicon').removeClass(
                'glyphicon-volume-off ' +
                'glyphicon-volume-down ' +
                'glyphicon-volume-up');

        if (volume >= 0.5) {
            $('#muteicon').addClass('glyphicon-volume-up');
        } else if (volume > 0) {
            $('#muteicon').addClass('glyphicon-volume-down');
        } else {
            $('#muteicon').addClass('glyphicon-volume-off');
        }
    };
    $('#volume').on('input', function(event) {
        var volume = $('#volume').val();
        $('#audio')[0].volume = volume;
        setVolume(volume);
        setVolumeIcon();
    });
    $('#mute').click(function(event) {
        if ($('#volume').val() === 0) {
            $('#audio')[0].volume = preMuteVolume;
            $('#volume').val(preMuteVolume);
        } else {
            preMuteVolume = $('#audio')[0].volume;
            $('#audio')[0].volume = 0;
            $('#volume').val(0);
        }
        setVolumeIcon();
    });
    $('#previous').click(function(event) {
        saveEmit('skipSongs', -1);
    });
    $('#next').click(function(event) {
        saveEmit('skipSongs', 1);
    });
    $('#playpause').click(function(event) {
        if (paused) {
            saveEmit('startPlayback');
        } else {
            saveEmit('pausePlayback');
        }
    });
    $('#shuffle').click(function(event) {
        saveEmit('shuffleQueue');
    });
    $('#stream').click(function(event) {
        var streamingButton = $('#stream');
        if (streaming) {
            streaming = false;
            var audio = document.getElementById('audio');

            streamingButton.removeClass('btn-primary');

            audio.pause();
        } else {
            streaming = true;

            streamingButton.addClass('btn-primary');

            startPlayback(true);
        }
    });
    $(function () {
      $('[data-toggle="tooltip"]').tooltip();
    });
    $('#loginModal').on('shown.bs.modal', function () {
        $('#inputUsername').focus();
    });
    $('#loginModal').on('hidden.bs.modal', function () {
        retryAfterLogin = _.noop;
    });
    $('#loginForm').submit(function(event) {
        event.preventDefault();

        $.ajax({
            type: 'POST',
            url: '/login',
            data: JSON.stringify({
                username: $('#inputUsername').val(),
                password: $('#inputPassword').val()
            }),
            contentType: 'application/json'
        })
        .done(function(data) {
            console.log(data);
            updateLogin(function() {
                $('#loginModal').modal('hide');

                retryAfterLogin();
                retryAfterLogin = _.noop;
            }, true);
        })
        .error(function(res) {
            $('#loginError').text(res.responseText);
        });
    });
    updateLogin();
});
