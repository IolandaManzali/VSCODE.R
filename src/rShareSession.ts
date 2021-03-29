import path = require('path');
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import { globalRHelp, rWorkspace } from './extension';
import { UUID } from './rShare';
import { dispatchRStudioAPICall } from './rstudioapi';
import { config } from './util';
import { showBrowser, showDataView, showWebView } from './session';
import { rGuestService } from './rShare';

let guestPid: string;
let guestPlotView: string;
export let guestGlobalenv: unknown;
export let guestResDir: string;

interface IRequest {
    command: string;
    time?: string;
    pid?: string;
    wd?: string;
    source?: string;
    type?: string;
    title?: string;
    file?: string;
    viewer?: string;
    plot?: string;
    action?: string;
    args?: any;
    sd?: string;
    url?: string;
    requestPath?: string;
    UUID?: number;
}

export function initGuest(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('r.attachActiveGuest', () => attachActiveGuest())
    );

    // create status bar item that contains info about the *guest* session watcher
    console.info('Create guestSessionStatusBarItem');
    const sessionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    sessionStatusBarItem.command = 'r.attachActiveGuest';
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    sessionStatusBarItem.tooltip = 'Attach to Host Terminal';
    sessionStatusBarItem.show();
    context.subscriptions.push(sessionStatusBarItem);
    rGuestService.setStatusBarItem(sessionStatusBarItem);
    guestResDir = path.join(context.extensionPath, 'dist', 'resources');
}

export function attachActiveGuest(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActiveGuest]');
        void rGuestService.requestAttach();
    } else {
        void vscode.window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}


// Guest version of session.ts updateRequest(), no need to check for changes in files
// as this is handled by the session.ts variant
export async function updateGuestRequest(sessionStatusBarItem: vscode.StatusBarItem): Promise<void> {
    const requestContent: string = await rGuestService.getRequestContent();
    console.info(`[updateGuestRequest] request: ${requestContent}`);
    if (typeof (requestContent) === 'string') {
        const request: IRequest = JSON.parse(requestContent) as IRequest;
        if (request) {
            if (request.UUID === null || request.UUID === undefined || request.UUID === UUID) {
                switch (request.command) {
                    case 'help': {
                        if (globalRHelp) {
                            console.log(request.requestPath);
                            void globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                        }
                        break;
                    }
                    case 'attach': {
                        guestPid = String(request.pid);
                        guestPlotView = String(request.plot);
                        console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
                        sessionStatusBarItem.text = `Guest R: ${guestPid}`;
                        sessionStatusBarItem.show();
                        break;
                    }
                    case 'browser': {
                        await showBrowser(request.url, request.title, request.viewer);
                        break;
                    }
                    case 'webview': {
                        void showWebView(request.file, request.title, request.viewer);
                        break;
                    }
                    case 'dataview': {
                        void showDataView(request.source,
                            request.type, request.title, request.file, request.viewer);
                        break;
                    }
                    case 'rstudioapi': {
                        await dispatchRStudioAPICall(request.action, request.args, request.sd);
                        break;
                    }
                    default:
                        console.error(`[updateRequest] Unsupported command: ${request.command}`);
                }
            }
        }
    }
}

// Call from host, pass globalenvfile
export async function updateGuestGlobalenv(): Promise<void> {
    const content: string = await rGuestService.getGlobalenvContent();
    if (typeof content === 'string') {
        guestGlobalenv = JSON.parse(content);
        void rWorkspace?.refresh();
        console.info('[updateGuestGlobalenv] Done');
    }
}

export async function updateGuestPlot(file: string): Promise<void> {
    const plotContent = await rGuestService.requestFileContent(file);
    if (typeof plotContent === 'string') {
        await fs.outputFile(
            file,
            plotContent
        );
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), {
            preserveFocus: true,
            preview: true,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            viewColumn: vscode.ViewColumn[guestPlotView],
        });

    }
}
