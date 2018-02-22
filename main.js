function duration_to_string(seconds) {
    if (!seconds) {
        return 'unknown';
    }
    var minutes = Math.round(seconds / 60);
    seconds = seconds % 60;
    return minutes + ':' + ('0' + seconds).slice(-2);
}

function datetime_to_string(date) {
    date = new Date(date);
    return (date - (new Date(0))) != 0 && date.toDateString();
}

function slash_unescape(string) {
    return string.replace(/\\(.)/g, '$1');
}

function bypass_cors(data) {
    var url = data.url;
    if (data.data) {
        url += '?' + $.param(data.data);
        delete data.data;
    }

    data.url = 'https://query.yahooapis.com/v1/public/yql'
    data.data = {q: 'SELECT * FROM json WHERE url=' + JSON.stringify(url), format: 'json'}
    data.dataType = 'text';
    return $.post(data);
}

function parse_query(query) {
    var tokens = query.split(/\s+/);
    data = {query: []};

    for(var i = 0; i < tokens.length; i ++) {
        if(tokens[i].startsWith('minDuration=')) {
            data['minDuration'] = tokens[i].split('=', 2)[1]*1;
        } else if(tokens[i].startsWith('published=')) {
            var date = new Date(tokens[i].split('=', 2)[1]);
            if (isNaN(date.getTime())) {
                // invalid date
                // TODO: proper error handling
            } else {
                // recreate date to match with locale
                date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                data['published'] = date;
            }
        } else if(tokens[i].startsWith('videoId=')) {
            data['videoId'] = tokens[i].split('=', 2)[1];
        } else {
            data.query.push(tokens[i]);
        }
    }

    data.query = data.query.join(' ');
    return data;
}

function build_query(query) {
    // var data = {m: '1', range: '1-1000000', form: 'json'};
    var data = {range: '1-1000000', form: 'json'};
    data.fields = ['title', 'id', 'media$content', 'media$expirationDate', 'pubDate', 'description', 'defaultThumbnailUrl'].join(',');

    if (query.published) {
        data['byPubDate'] = query.published.getTime() + '~' + (query.published.getTime() + 24*3600*1000);
    }

    if (query.videoId) {
        data.url = 'https://www.sbs.com.au/api/video_feed/f/Bgtm9B/sbs-od2-video/' + query.videoId;
    } else if (query.query == '') {
        data.url = 'https://www.sbs.com.au/api/video_feed/f/Bgtm9B/sbs-section-sbstv';
    } else {
        // use /video_search endpoint when query is given so we get sorted results
        data.url = 'https://www.sbs.com.au/api/video_search/v2/';
        // limit to 50 results
        data.range = '1-50';
        data.m = '1'
        data.q = query.query;
    }
    data.parser = function(response) {
        var entries = JSON.parse(response).query.results.json.entries;
        if (!Array.isArray(entries)) {
            entries = [entries];
        }
        return entries;
    };
    return data;
}

function search_videos(query, callback) {
    var parsed_query = parse_query(query);
    query = build_query(parsed_query);
    var url = query.url;
    var parser = query.parser;

    delete query.url;
    delete query.parser;

    bypass_cors({
        url: url,
        data: query,
        error: function(xhr, status, error) {
            callback({error: 'Failed to connect to API'});
        },
        success: function(data, status, xhr) {
            try {
                data = parser(data);
            } catch(err) {
                callback({error: 'Malformed data: ' + err});
            }
            callback({videos: data}, parsed_query);
        }
    })
}

function process_video_data(data, query) {
    var videos = (data.videos || []);
    data.videos = [];

    for(var i = 0; i < videos.length; i ++) {
        var video = videos[i];

        video['_id'] = /\d+$/.exec(video['id'])[0];
        var thumbnail = slash_unescape(video['plmedia_defaultThumbnailUrl']);
        // parse {ssl:https\://...:http\://...}/abc/xyz
        var parts = thumbnail.match(/({ssl:((\\.|[^\\])*):.*})?(.*)/);
        video['thumbnail'] = slash_unescape(parts[2] || '') + parts[4];

        var duration = (video['media_content'] && video['media_content'][0]);
        duration = (duration && parseInt(duration['plfile_duration']));

        video['duration'] = duration_to_string(duration);
        video['published'] = datetime_to_string(parseInt(video['pubDate']));
        video['expiry'] = datetime_to_string(parseInt(video['media_expirationDate']));

        if (query.minDuration && query.minDuration > (duration || query.minDuration)) {
            continue;
        }
        if (query.published && datetime_to_string(query.published) != video.published) {
            continue;
        }

        var expiry = new Date(parseInt(video['media_expirationDate']));
        if((expiry - (new Date(0))) == 0) {
            expiry = null;
        }
        // expires within 2 days
        video['expires_soon'] = (expiry && expiry < (Date.now() + 3600*1000*24*2));

        data['videos'].push(video);
    }

    return data;
}

function process_link_data(data) {
    var links = (data.links || []);

    links = _.unique(links, 'url');
    for(var i = 0; i < links.length; i ++) {
        if (!links[i].bitrate) {
            links[i].bitrate = bitrate_from_url(links[i].url);
        }

        // set a link name, using bitrate or file extension (or 'Link')
        if (links[i].bitrate) {
            links[i].name = links[i].bitrate + 'K';
        } else {
            var extension = /\.([^./?]+)(\?|$)/.exec(links[i].url);
            if (extension) {
                links[i].name = extension[1].toUpperCase();
            } else {
                links[i].name = 'Link';
            }
        }
    }

    links.sort(function(a, b) {
        return (b.bitrate || 0) - (a.bitrate || 0);
    });

    // group all the links by type
    links = _.partition(links, 'backup');
    var backup_links = links[0];
    links = links[1];

    links = format_links(links);
    backup_links = format_links(backup_links);
    links = [
        {links: links},
        {links: backup_links, title: 'Backup links'},
    ];
    links = _.filter(links, function(l) { return l.links.length; });
    data.links = links;
    return data;
}

function format_links(links) {
    links = _.pairs(_.groupBy(links, 'type'));
    for(var i = 0; i < links.length; i ++) {
        links[i] = {type: links[i][0], urls: links[i][1]};
    }
    links = _.sortBy(links, 'type');
    return links;
}

function set_loading(context, loading) {
    context.find('.input-control').prop('disabled', loading);
    context.find('.non-spinner').toggle(!loading);
    context.find('.spinner').toggle(loading);
}

function load_video_data(template) {
    var query = $('#search-box').val();
    if (query == '') {
        return;
    }

    set_loading($('#search-form'), true);
    $('#video-results').html('');

    search_videos(query, function(result, ...args) {
        result = process_video_data(result, ...args);
        result = template.render(result);

        set_loading($('#search-form'), false);
        $('#video-results').html(result);
    });
}

function load_link_data(template, id) {
    set_loading($('#video-' + id + ' .link-section'), true);
    $('#video-' + id + ' .link-item').html('');

    fetch_video_links(id, function(result) {
        result = process_link_data(result)
        result = template.render(result);

        set_loading($('#video-' + id + ' .link-section'), false);
        $('#video-' + id + ' .link-item').html(result);
    });
}

$(document).ready(function() {

    // compile template
    var video_template = Hogan.compile($('#video-template').html());
    var link_template = Hogan.compile($('#link-template').html());

    $('#search-form').on('submit', function(e) {
        load_video_data(video_template);
        e.preventDefault();
    });

    $('body').on('click', 'button.link-fetcher', function() {
        var id = this.getAttribute('data-video-id');
        load_link_data(link_template, id);
    });

    $('body').on('click', '.video-link-box', function(){ this.select(); });

})
