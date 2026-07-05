/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

// $local - enable i18n translation
// $back  - control when the wrapper becomes visible
// $dom   - cache static DOM elements
const $local = false, $back = false, $dom = {
    main:        $('.sdpi-wrapper'),
    apiKey:      $('#apiKey'),
    model:       $('#model'),
    prompt:      $('#prompt'),
    maxTokens:   $('#maxTokens'),
    temperature: $('#temperature')
};

const $propEvent = {
    didReceiveSettings(data) {
        const s = data.settings || {};
        $dom.apiKey.value      = s.apiKey      || '';
        $dom.model.value       = s.model       || 'gpt-4o-mini';
        $dom.prompt.value      = s.prompt      || '';
        $dom.maxTokens.value   = s.maxTokens   !== undefined ? s.maxTokens : 256;
        $dom.temperature.value = s.temperature !== undefined ? s.temperature : 0.7;
    },

    sendToPropertyInspector(data) {
        if (data.event === 'getSettings') {
            $propEvent.didReceiveSettings(data);
        }
    }
};

// Persist changes whenever any field changes
function saveAll() {
    $settings.apiKey      = $dom.apiKey.value.trim();
    $settings.model       = $dom.model.value;
    $settings.prompt      = $dom.prompt.value;
    $settings.maxTokens   = parseInt($dom.maxTokens.value, 10) || 256;
    $settings.temperature = parseFloat($dom.temperature.value) || 0.7;
}

$dom.apiKey.on('input',      saveAll);
$dom.model.on('change',      saveAll);
$dom.prompt.on('input',      saveAll);
$dom.maxTokens.on('input',   saveAll);
$dom.temperature.on('input', saveAll);
