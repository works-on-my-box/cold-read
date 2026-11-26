// The second way to switch the one-click run off, by a new deploy (a minor version). The first way needs no deploy:
// the feature flag one_click_run in the developer console (src/guard.js). The Rovo chat and the MCP tools keep working.
// BLOCKED_CLOUD_IDS: sites whose one-click run is off (the site ID, as in the installContext ARI "…/site/<id>").
// BUTTON_ENABLED: false switches it off on every site. BUTTON_EXPIRES: from then on the button calls no model.
// NEW_INSTALLS_PAUSED_FROM: null, or an ISO date: an installation made then or later gets the refusal of a blocked
// site (the installations made before keep their one-click runs).
export const BLOCKED_CLOUD_IDS = [];
export const BUTTON_ENABLED = true;
export const BUTTON_EXPIRES = '2027-02-20T00:00:00Z';
export const NEW_INSTALLS_PAUSED_FROM = null;
