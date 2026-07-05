/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

// $local - enable i18n translation
// $back  - control when the wrapper becomes visible
// $dom   - cache static DOM elements
const $local = false, $back = false, $dom = {
    main: $('.sdpi-wrapper'),
    url:  $('#url')
};

const $propEvent = {
    didReceiveSettings(data) {
        const s = data.settings || {};
        $dom.url.value = s.url || 'https://chatgpt.com';
    },

    sendToPropertyInspector(data) {
        if (data.event === 'getSettings') {
            $propEvent.didReceiveSettings(data);
        }
    }
};

function saveAll() {
    $settings.url = $dom.url.value.trim() || 'https://chatgpt.com';
}

$dom.url.on('input', saveAll);
