function parse_url(url) {
    const parser = document.createElement('a');
    parser.href = url;
    return parser;
}

function bitrate_from_url(url) {
    // eg http://sbsauvod-f.akamaihd.net/SBS_Production/managed/2014/09/04/2014-09-04_273396_1500K.mp4?...
    // eg http://videocdn.sbs.com.au/u/video/SBS_Production/managed/2015/10/30/555273795946_1500K.mp4
    // eg rtmp://cp99272.edgefcs.net/ondemand/pub/DOC_EXT_No_Turning_Back_Tha_507_549627_1500K.mp4
    // eg http://sbsvodns-vh.akamaihd.net/z/vod/SBS_Production/managed/2016/04/11/2016-04-11_452901_,1500,K.mp4.csmil/manifest.f4m?...
    const match = /_,?(\d+),?K\.mp4/.exec(url);
    return (match && match[1]*1);
}

async function fetch_video_links(id) {
    const url = 'https://www.sbs.com.au/api/video_pdkvars/id/' + id;

    let data = await bypass_cors(url);
    // turn "x=1&y=2&y[z]=3" into {x:'1', y:{'':'2', 'z':'3'}}
    data = new URLSearchParams(data);
    // reverse sort so that deeply nested keys come first
    data = Array.from(data.entries()).sort().reverse();
    const parsed = {};
    for(let [key, value] of data) {
        let container = parsed;
        while (true) {
            const match = /^(\w+)\[(\w+)\](.*)/.exec(key);
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
            throw new Error(`Error: ${data.error.expandedErrorCode.errorCode}`);
        }
        data = data.releaseUrls;
    } catch(e) {
        throw new Error(`Malformed data: ${e}`);
    }
    // grab all release urls
    const smils = [];
    for(const key in data) {
        if (data[key] != '') {
            smils.push(data[key]);
        }
    }

    const links = [];
    for await (const link of fetch_smils(smils)) {
        links.push(link);
    }
    return links;
}

async function* fetch_smils(smils) {
    const links = [];
    for (const smil of smils) {

        let url = parse_url(smil);
        url.protocol = 'https';
        url = url.href;

        let get = async (...args) => {
            const response = await fetch(...args);
            return (await response.text());
        };
        if (url.startsWith('https://www.sbs.com.au/')) {
            get = bypass_cors;
        }

        let data;
        try {
            data = await get(url);
        } catch(e) {
            console.log(`Error fetching: ${url}`);
            continue;
        }

        data = new window.DOMParser().parseFromString(data, 'text/xml');

        // base is used for rtmp links
        const base = data.querySelector('meta')?.getAttribute('base')?.replace(/\/+$/, '');

        for (const node of data.querySelectorAll('textstream')) {
            yield {type: 'Captions', url: node.getAttribute('src')};
        }

        let sources = Array.from(data.querySelectorAll('video').values()).map(node => node.getAttribute('src'));
        sources = new Set(sources); // unique

        for await (const link of parse_video_sources(sources, base)) {
            yield link;
        }
    }
}

async function* parse_video_sources(sources, base) {
    for (const src of sources) {
        const url = parse_url(src);

        if (url.hostname.startsWith('pubads') || url.hostname.startsWith('securepubads')) {
            // ads
        } else if (url.hostname.startsWith('videocdn.sbs.com.au') && url.pathname.startsWith('/u/video')) {
            // direct
            yield {type: 'Direct', url: src};
        } else if (url.pathname.endsWith('.m3u8')) {
            // m3u8
            for await (const link of get_urls_from_m3u(src)) {
                yield link
            }
        } else if (url.pathname.endsWith('/manifest.f4m')) {
            // f4m/hds
            url.search += '&hdcore=';
            const match = url.href.match(/_,((\d+,)+)K\.mp4\.csmil/);
            if (match) {
                // manifest containing multiple bitrate links
                // we create a separate link for each bitrate
                const bitrates = match[1].split(',');
                for (const bitrate of bitrates) {
                    if (bitrate != '') {
                        yield {type: 'F4M', url: url.href.replace(match[1], bitrate + ',')};
                    }
                }
            } else if (url.pathname.match(/_\d+K\.mp4/)) {
                yield {type: 'F4M', url: url.href};
            } else {
                // multi bitrate but can't get separate link per bitrate ...
                yield {type: 'F4M', url: url.href};
            }

        } else if (src.match(/^http(s?):\/\/sbs[a-z]+-f\.akamaihd\.net/)) {
            // unencrypted
            yield {type: 'FLV', url: src + '?v=&fp=&r=&g='};
        } else if (!src.startsWith('https://') && base) {
            // rtmp
            yield {type: 'RTMP', url: base + '/' + src.replace(/^\/+/, '')}
        } else {
            // unhandled
            console.log(`Unhandled source: ${src}`);
            yield {type: 'unknown', url: src};
        }
    }
}

async function* get_urls_from_m3u(url) {
    let data;
    try {
        const response = await fetch(url);
        data = await response.text();
    } catch(e) {
        console.log(`Error fetching: ${url}`);
        return;
    }
    // data is in m3u playlist format
    data = data.split('\n#');
    // ignore ext m3u header
    data.shift();
    for (const x of data) {
        const lines = x.split('\n');
        if (lines.length < 2) {
            continue;
        }
        const resolution = /RESOLUTION=(\d+x\d+),/.exec(lines[0]);
        const backup = lines[1].match(/a(v?)-b\.m3u8\?/);
        const bitrate = Math.floor(/BANDWIDTH=(\d+),/.exec(lines[0])[1] / 1000);

        yield {
            url: lines[1],
            bitrate,
            backup,
            type: resolution ? 'M3U' : 'AUDIO',
        };
    }
}
