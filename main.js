const box = document.querySelector('#search-box');
const form = document.querySelector('#search-form');
const body = document.querySelector('body');
const video_results = document.querySelector('#video-results');

// compile template
let video_template = Hogan.compile(document.querySelector('#video-template').innerHTML);
let link_template = Hogan.compile(document.querySelector('#link-template').innerHTML);

function duration_to_string(seconds) {
    if (!seconds) {
        return 'unknown';
    }
    const minutes = Math.round(seconds / 60);
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

async function bypass_cors(url, params) {
    if (params) {
        url = url + '?' + (new URLSearchParams(params).toString());
    }

    url = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);
    const response = await fetch(url);
    const data = await response.json();
    if (data.status.http_code && 200 <= data.status.http_code && data.status.http_code < 300) {

        const match = data.contents.match(/^data:[a-zA-Z+/-]+;base64,/);
        if (match) {
            data.contents = atob(data.contents.slice(match[0].length));
        }

        return data.contents;

    } else {
        throw new Error(data.status.http_code);
    }
}

async function bypass_cors(url, params) {
    url = url + '?' + (new URLSearchParams(params).toString())
    url = 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(url);
    const response = await fetch(url);
    return (await response.text());
}

function parse_query(query) {
    const tokens = query.split(/\s+/);
    data = {query: []};

    for (const token of tokens) {
        if (token.startsWith('minDuration=')) {
            let duration = token.split('=', 2)[1];
            if (duration.toLowerCase().endsWith('m')) {
                duration = duration.slice(0, -1)*60;
            } else if (duration.toLowerCase().endsWith('h')) {
                duration = duration.slice(0, -1)*3600;
            } else {
                duration = duration*1;
            }
            data['minDuration'] = duration;

        } else if (token.startsWith('published=')) {
            let date = token.split('=', 2)[1];
            if (date == 'today') {
                date = new Date();
            } else if (date == 'yesterday') {
                date = new Date();
                date.setDate(date.getDate() - 1);
            } else {
                date = new Date(date);
            }

            if (isNaN(date.getTime())) {
                // invalid date
                // TODO: proper error handling
            } else {
                // recreate date to match with locale
                date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                data['published'] = date;
            }

        } else if (token.startsWith('videoId=')) {
            data.videoId = token.split('=', 2)[1];

        } else {
            data.query.push(token);
        }
    }

    data.query = data.query.join(' ');
    return data;
}

function build_query(query) {
    // const data = {m: '1', range: '1-1000000', form: 'json'};
    const params = {range: '1-1000000', form: 'json'};
    // params.fields = ['title', 'id', 'media$content', 'media$expirationDate', 'pubDate', 'description', 'defaultThumbnailUrl'].join(',');

    let url;
    let parser = function(response) {
        return response.entries;
    };

    if (query.published) {
        params.byPubDate = query.published.getTime() + '~' + (query.published.getTime() + 24*3600*1000);
    }

    if (query.videoId) {
        url = 'https://www.sbs.com.au/api/video_feed/f/Bgtm9B/sbs-od2-video/' + query.videoId;
    } else if (query.query == '') {
        url = 'https://www.sbs.com.au/api/video_feed/f/Bgtm9B/sbs-section-sbstv';
    } else {
        // use /video_universalsearch endpoint when query is given so we get sorted results
        url = 'https://www.sbs.com.au/api/v3/video_universalsearch'
        // params.context = 'odwebsite'
        // limit to 50 results
        params.range = '1-50';
        // params.m = '1'
        params.q = query.query;
        parser = function(response) {
            if (response.get?.status == 'failed') {
                throw new Error(response.get.response.message);
            }
            return response.itemListElement.filter(v => v.type !== 'TVSeries');
        }
    }
    return {params, url, parser};
}

async function search_videos(query) {
    const {params, url, parser} = build_query(query);
    const data = await bypass_cors(url, params);
    const videos = parser(JSON.parse(data));
    return {videos};
}

function process_video_data(data, query) {
    const videos = data.videos || [];
    data.videos = [];

    for (const video of videos) {
        video.title = video.title || video.name;
        video._id = /\d+$/.exec(video.id)[0];

        video.thumbnail = null;
        if (video['plmedia$defaultThumbnailUrl']) {
            video.thumbnail = slash_unescape(video['plmedia$defaultThumbnailUrl']);
        } else if (video.thumbnailUrl) {
            video.thumbnail = video.thumbnailUrl;
        } else {
            const thumbnails = video['media$thumbnails'];
            for (const thumbnail of thumbnails) {
                if (thumbnail && thumbnail['plfile$downloadUrl']) {
                    video.thumbnail = thumbnail['plfile$downloadUrl'];
                    break
                }
            }
        }

        // parse {ssl:https\://...:http\://...}/abc/xyz
        const parts = video.thumbnail?.match(/({ssl:((\\.|[^\\])*):.*})?(.*)/);
        video.thumbnail = parts && (slash_unescape(parts[2] || '') + parts[4]);
        video.thumbnail = video.thumbnail?.replace(/(.*_)[a-z]*(\.[a-z]*)/i, '$1small$2');

        let duration = video.duration;
        if (!duration) {
            const media_content = video['media$content'] && video['media$content'][0];
            duration = media_content && parseInt(media_content['plfile$duration']);
        }
        video.duration = duration_to_string(duration);

        video.published = datetime_to_string(video.offer?.availabilityStarts || parseInt(video.pubDate));

        video.language = video['pl1$language'] || video.inLanguage?.map(l => l.name).join(', ')

        if (query.minDuration && query.minDuration > (duration || query.minDuration)) {
            continue;
        }
        if (query.published && datetime_to_string(query.published) != video.published) {
            continue;
        }

        let expiry = video.offer?.availabilityStarts || new Date(parseInt(video['media$expirationDate']));
        if ((expiry - (new Date(0))) == 0) {
            expiry = null;
        }
        video.expiry = datetime_to_string(expiry);
        video.expired = expiry && expiry < Date.now();
        // expires within 2 days
        video.expires_soon = expiry && expiry < (Date.now() + 3600*1000*24*2);

        data.videos.push(video);
    }

    return data;
}

function process_links(links) {
    links = _.unique(links, 'url');
    for (const link of links) {
        if (!link.bitrate) {
            link.bitrate = bitrate_from_url(link.url);
        }

        // set a link name, using bitrate or file extension (or 'Link')
        if (link.bitrate) {
            link.name = link.bitrate + 'K';
        } else {
            const extension = /\.([^./?]+)(\?|$)/.exec(link.url);
            if (extension) {
                link.name = extension[1].toUpperCase();
            } else {
                link.name = 'Link';
            }
        }
    }

    links.sort(function(a, b) {
        return (b.bitrate || 0) - (a.bitrate || 0);
    });

    // group all the links by type
    links = _.partition(links, 'backup');
    let backup_links = links[0];
    links = links[1];

    links = format_links(links);
    backup_links = format_links(backup_links);
    links = [
        {links: links},
        {links: backup_links, title: 'Backup links'},
    ];
    links = _.filter(links, function(l) { return l.links.length; });
    return links;
}

function format_links(links) {
    links = _.pairs(_.groupBy(links, 'type'));
    for(let i = 0; i < links.length; i ++) {
        links[i] = {type: links[i][0], urls: links[i][1]};
    }
    links = _.sortBy(links, 'type');
    return links;
}

function set_loading(context, loading) {
    context.querySelector('.input-control').disabled = loading;
    context.querySelector('.non-spinner').style.display = loading ? 'none' : '';
    context.querySelector('.spinner').style.display = loading ? '' : 'none';
}

async function load_video_data(template) {
    if (box.value == '') {
        return;
    }

    set_loading(form, true);
    video_results.innerHTML = '';

    const query = parse_query(box.value);
    let results;
    try {
        results = await search_videos(query);
        results = process_video_data(results, query);
    } catch(e) {
        console.error(e);
        results = {error: e.toString()};
    }
    results = template.render(results);

    set_loading(form, false);
    video_results.innerHTML = results;
}

async function load_link_data(button) {
    const id = button.getAttribute('data-video-id');
    const link_section = document.querySelector(`#video-${id} .link-section`);
    const link_item = document.querySelector(`#video-${id} .link-item`);
    set_loading(link_section, true);
    link_item.innerHTML = '';

    let result;
    try {
        result = await fetch_video_links(id);
        result = {links: process_links(result)}
    } catch(e) {
        console.error(e);
        result = {error: e.toString()};
    }

    result = link_template.render(result);
    set_loading(link_section, false);
    link_item.innerHTML = result;
}

document.addEventListener('DOMContentLoaded', function() {

    window.onhashchange = function(e) {
        box.value = decodeURI(window.location.hash.replace(/^#/, ''));
        form.onsubmit();
        if (e) {
            e.preventDefault();
        }
    };

    form.onsubmit = function(e) {
        window.location.hash = box.value;
        load_video_data(video_template);
        if (e) {
            e.preventDefault();
        }
    };

    window.onhashchange();
})
