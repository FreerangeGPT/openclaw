// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Mattermost runtime barrel into lightweight plugin loads.
export { mattermostPlugin } from "./src/channel.js";

