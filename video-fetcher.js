function parse_url(url) {
    var parser = document.createElement('a');
    parser.href = url;
    return parser;
}

function bitrate_from_url(url) {
    // eg http://sbsauvod-f.akamaihd.net/SBS_Production/managed/2014/09/04/2014-09-04_273396_1500K.mp4?...
    // eg http://videocdn.sbs.com.au/u/video/SBS_Production/managed/2015/10/30/555273795946_1500K.mp4
    // eg rtmp://cp99272.edgefcs.net/ondemand/pub/DOC_EXT_No_Turning_Back_Tha_507_549627_1500K.mp4
    // eg http://sbsvodns-vh.akamaihd.net/z/vod/SBS_Production/managed/2016/04/11/2016-04-11_452901_,1500,K.mp4.csmil/manifest.f4m?...
    var match = /_,?(\d+),?K\.mp4/.exec(url);
    return (match && match[1]*1);
}

function fetch_video_links(id, callback) {
    var url = 'https://www.sbs.com.au/api/video_pdkvars/id/' + id;

    bypass_cors({
        url: url,
        error: function(xhr, status, error) {
            callback({error: 'Error loading ' + url});
        },
        success: function(data, status, xhr) {
            // turn "x=1&y=2&y[z]=3" into {x:'1', y:{'':'2', 'z':'3'}}
            data = new URLSearchParams(data);
            // reverse sort so that deeply nested keys come first
            data = Array.from(data.entries()).sort().reverse();
            var parsed = {};
            for(var [key, value] of data) {
                var container = parsed;
                while (true) {
                    var match = /^(\w+)\[(\w+)\](.*)/.exec(key);
                    if (match) {
                        if (!(match[1] in container)) {
                            container[match[1]] = {}
                        }
                        container = container[match[1]]
                        key = match[2] + match[3];
                    } else if (key in container) {
                        container = container[key];
                        key = '';
                    } else {
                        container[key] = value;
                        break;
                    }
                }
            }
            data = parsed;


            try {
                if (data.error) {
                    callback({error: 'Error: ' + data.error.expandedErrorCode.errorCode});
                    return;
                }
                data = data.releaseUrls;
            } catch(err) {
                callback({error: 'Malformed data: ' + err});
                return;
            }
            // grab all release urls
            var smils = [];
            for(var key in data) {
                if (data[key] != '') {
                    smils.push(data[key]);
                }
            }

            fetch_smils(smils, [], function(links) {
                callback({links: links});
            });
        },
    });
}

function fetch_smils(smils, links, callback) {
    if (smils.length == 0) {
        callback(links);
        return;
    }

    var url = parse_url(smils.pop());
    url.protocol = 'https';
    url = url.href;

    var get = $.get;
    if (url.startsWith('https://www.sbs.com.au/')) {
        get = bypass_cors;
    }

    get({
        url: url,
        // dataType: 'xml',
        error: function(xhr, status, error) {
            console.log('Error fetching: ' + url);
            fetch_smils(smils, links, callback);
        },
        success: function(data, status, xhr) {
            data = $(data);

            // base is used for rtmp links
            var base = data.find('meta').attr('base');
            base = base && base.replace(/\/+$/, '');

            data.find('textstream').each(function(i, e) {
                links.push({type: 'Captions', url: e.getAttribute('src')});
            });

            var sources = data.find('video').map(function(i, e) {
                return e.getAttribute('src');
            }).get();
            sources = _.unique(sources);

            parse_video_sources(sources, base, links, function(links) {
                fetch_smils(smils, links, callback);
            });
        },
    });
}

function parse_video_sources(sources, base, links, callback) {
    if (sources.length == 0) {
        callback(links);
        return;
    }

    var src = sources.pop();

    var match = /^http(s?):\/\/sbs[a-z]+-([vl])h\.akamaihd\.net/.exec(src);
    if (match) {
        var parts = parse_url(src);
        // encrypted
        if (!parts.pathname.match('manifest.f4m')) {
            // m3u
            get_urls_from_m3u(src, function(new_links) {
                parse_video_sources(sources, base, links.concat(new_links), callback);
            });
            return;
        }

        // f4m/hds
        parts.search += '&hdcore=';
        src = parts.href;
        var match = /_,((\d+,)+)K\.mp4\.csmil/.exec(src);
        if (match) {
            // manifest containing multiple bitrate links
            // we create a separate link for each bitrate
            var bitrates = match[1].split(',');
            for(var i = 0; i < bitrates.length; i ++) {
                if (bitrates[i] != '') {
                    links.push({type: 'F4M', url: src.replace(match[1], bitrates[i] + ',')});
                }
            }
        } else if (parts.pathname.match(/_\d+K\.mp4/)) {
            links.push({type: 'F4M', url: src});
        } else {
            // multi bitrate but can't get separate link per bitrate ...
            links.push({type: 'F4M', url: src});
        }

    } else if (src.match(/^http(s?):\/\/sbs[a-z]+-f\.akamaihd\.net/)) {
        // unencrypted
        links.push({type: 'FLV', url: src + '?v=&fp=&r=&g='});
    } else if (!src.startsWith('https://') && base) {
        // rtmp
        links.push({type: 'RTMP', url: base + '/' + src.replace(/^\/+/, '')})
    } else if (src.startsWith('http://videocdn.sbs.com.au/u/video')) {
        // direct
        links.push({type: 'Direct', url: src});
    } else if (src.match(/^http(s?):\/\/pubads/)) {
        // ads
    } else {
        // unhandled
        console.log('Unhandled source: ' + src);
        links.push({type: 'unknown', url: src});
    }

    parse_video_sources(sources, base, links, callback);
}

function get_urls_from_m3u(url, callback) {
    $.get({
        url: url,
        dataType: 'text',
        error: function(xhr, status, error) {
            console.log('Error fetching: ' + url);
            callback([]);
        },
        success: function(data, status, xhr) {
            // data is in m3u playlist format
            data = data.split('\n#');
            var links = [];
            // ignore ext m3u header
            for(var i = 1; i < data.length; i ++) {
                var lines = data[i].split('\n');
                var resolution = /RESOLUTION=(\d+x\d+),/.exec(lines[0]);
                var backup = lines[1].match(/a(v?)-b\.m3u8\?/);
                var bitrate = /BANDWIDTH=(\d+),/.exec(lines[0])[1] / 1000;

                var link = {url: lines[1], bitrate: bitrate, backup: backup};

                if (resolution) {
                    // video
                    link.type = 'M3U';
                    links.push(link);
                } else {
                    // audio
                    link.type = 'AUDIO';
                    links.push(link);
                }
            }
            callback(links);
        },
    });
}
