const ts = () => new Date().toISOString().slice(11, 19);
export const log = (...a) => console.log(ts(), ...a);
export const warn = (...a) => console.warn(ts(), "WARN", ...a);
export const err = (...a) => console.error(ts(), "ERR ", ...a);
