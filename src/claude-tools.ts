// The Claude plan's headless argv for the built-in tools. The runs and their gallery saves live in tool-runtimes.ts.
import {resolve} from 'node:path';
import type {ToolRuntime} from './tool-runtimes.ts';

/** The Claude CLI settings for one runtime. ClaudeRuntime keeps its name: worlds.ts and server.ts import it, and it is the Claude variant of ToolRuntime. */
export type ClaudeSettings={executable:string;defaultModel:string;fastModel:string;workspaceRoot?:string;denyRead?:string[]};
export type ClaudeRuntime=ToolRuntime;

// No web tools: a run that could read a file and also reach the network could send it out. Research goes through web_search and fetch_url.
export const CLAUDE_CODE_TOOLS='Read,Write,Edit,Glob,Grep';
// Read deny rules for code runs: the data folder (API keys, connector secrets, paired devices) and the home folders that hold
// sign-ins and browser profiles. Paths use Claude Code's rule form: `//` plus the absolute path with the drive as /c on Windows.
export const denyRules=(dataDir:string)=>{
  const abs=resolve(dataDir).replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_:string,d:string)=>`/${d.toLowerCase()}`).replace(/\/+$/,'');
  return [`/${abs}/**`,'~/.claude/**','~/.claude.json','~/.codex/**','~/.gemini/**','~/.ssh/**','~/.aws/**','~/.config/**','~/AppData/**'];
};

export const claudeSearchArgs=(model:string)=>['-p','--output-format','json','--model',model,'--tools','WebSearch','--allowedTools','WebSearch','--setting-sources','','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'];

// No --allowedTools: acceptEdits approves edits inside the workspace only, and anything outside it would need an approval a
// headless run never gets. The deny rules are a second fence around the data folder and the sign-in folders.
export const claudeCodeArgs=(model:string,denyRead:string[])=>['-p','--output-format','json','--permission-mode','acceptEdits','--tools',CLAUDE_CODE_TOOLS,'--disallowedTools','Bash',...denyRead.flatMap(p=>[`Read(${p})`,`Edit(${p})`]),'--setting-sources','','--strict-mcp-config','--disable-slash-commands','--no-session-persistence','--model',model];

// The browse run. Only the listed Playwright MCP tools (server 'browser' from --mcp-config) may run; no built-in tool runs. Left out on
// purpose: browser_file_upload (reads files on this computer), browser_evaluate and browser_run_code_unsafe (run code), and the cookie
// and storage tools (sign-in secrets). Checked against `claude --help` on this machine: -p, --output-format, --model, --mcp-config,
// --strict-mcp-config, --tools ("" disables every built-in), --allowedTools, --setting-sources, --disable-slash-commands, --no-session-persistence.
export const BROWSE_TOOLS=['navigate','navigate_back','navigate_forward','snapshot','click','type','fill_form','select_option','check','uncheck','hover','press_key','wait_for','tabs','handle_dialog','take_screenshot','drag','resize'].map(t=>`mcp__browser__browser_${t}`);
export const browseClaudeArgs=(model:string,mcpConfig:string)=>['-p','--output-format','json','--model',model,'--mcp-config',mcpConfig,'--strict-mcp-config','--tools','','--allowedTools',BROWSE_TOOLS.join(','),'--setting-sources','','--disable-slash-commands','--no-session-persistence'];
