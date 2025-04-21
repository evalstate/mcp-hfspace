import minimist from "minimist";
import path from "path";

export interface Config {
  claudeDesktopMode: boolean;
  workDir: string;
  spacePaths: string[];
  hfToken?: string;
  debug: boolean;
}

export const config = parseConfig();

export function parseConfig(): Config {
  const argv = minimist(process.argv.slice(2), {
    string: ["work-dir", "hf-token"],
    boolean: ["desktop-mode", "debug"],
    default: {
      "desktop-mode": process.env.CLAUDE_DESKTOP_MODE !== "false",
      "work-dir": process.env.MCP_HF_WORK_DIR || process.cwd(),
      "hf-token": process.env.HF_TOKEN,
      debug: false,
    },
    "--": true,
  });

  return {
    claudeDesktopMode: argv["desktop-mode"],
    workDir: path.resolve(argv["work-dir"]),
    hfToken: argv["hf-token"],
    debug: argv["debug"],
    spacePaths: (() => {
      const filtered = argv._.filter((arg) => arg.toString().trim().length > 0);
      return filtered.length > 0
        ? filtered
        : ["black-forest-labs/FLUX.1-schnell"];
    })(),
  };
}
