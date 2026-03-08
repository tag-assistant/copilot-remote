// Copilot Remote — Debug Logger
const DEBUG = process.env.COPILOT_REMOTE_DEBUG === '1' || process.env.DEBUG?.includes('copilot-remote') === true;
let _debug = DEBUG;

export const log = {
  info: (...args: any[]) => console.log(...args),
  error: (...args: any[]) => console.error(...args),
  debug: (...args: any[]) => {
    if (_debug) console.log('[DEBUG]', ...args);
  },
  sdk: (type: string, data?: any) => {
    if (_debug) {
      const d = data ? ' ' + JSON.stringify(data).slice(0, 300) : '';
      console.log('[SDK] ' + type + d);
    } else {
      console.log('[SDK] ' + type);
    }
  },
  telegram: (...args: any[]) => {
    if (_debug) console.log('[TG]', ...args);
  },
  get enabled() {
    return _debug;
  },
  set enabled(v: boolean) {
    _debug = v;
    console.log('[DEBUG] ' + (v ? 'ON' : 'OFF'));
  },
};
