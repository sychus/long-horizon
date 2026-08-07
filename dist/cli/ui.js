/**
 * Terminal output.
 *
 * `palace doctor` is the reason this module is opinionated about symbols: a
 * report you have to read carefully to notice a failure is a report that will
 * eventually be skimmed past. Failures are loud, warnings are distinct from
 * failures, and a clean run is unmistakably clean.
 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const cyan = wrap("36");
export const out = (line = "") => { process.stdout.write(line + "\n"); };
export const heading = (text) => { out(); out(bold(text)); };
export const ok = (text) => { out(`  ${green("✓")} ${text}`); };
export const warn = (text) => { out(`  ${yellow("!")} ${text}`); };
export const fail = (text) => { out(`  ${red("✗")} ${text}`); };
export const info = (text) => { out(`  ${dim("·")} ${text}`); };
export const hint = (text) => { out(`    ${dim(text)}`); };
/** Fatal error path shared by every command. */
export function die(message) {
    out();
    out(`${red("✗")} ${message}`);
    out();
    process.exit(1);
}
