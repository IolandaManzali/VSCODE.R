
import * as cp from 'child_process';
import * as kill from 'tree-kill';
import * as vscode from 'vscode';
import { getBrowserHtml } from '../session';
import { closeBrowser, isHost, shareBrowser } from '../liveshare';
import { config } from '../util';


interface IPreviewProcess {
    cp: cp.ChildProcessWithoutNullStreams,
    file: string,
    panel: vscode.WebviewPanel,
}

export class PreviewProvider {
    private openProcesses: IPreviewProcess[] = [];
    private activePreview: vscode.WebviewPanel;
    private activeResource: vscode.Uri;
    private activeExternalResource: vscode.Uri;

    public previewRmd(viewer: vscode.ViewColumn, uri?: vscode.Uri): void {
        const fileUri = uri ?? vscode.window.activeTextEditor.document.uri;
        const fileName = fileUri.path.substring(fileUri.path.lastIndexOf('/') + 1);
        const previewEngine: string = config().get('rmarkdown.previewEngine');
        const cmd = (
            `R --silent --slave --no-save --no-restore -e "${previewEngine}('${fileUri.path}')"`
        );

        let reg: RegExp = undefined;
        let call = undefined;

        // the regex can be extended in the future for other
        // calls
        switch (previewEngine) {
            // the rmarkdown::run url is of the structure:
            // http://127.0.0.1:port/file.Rmd
            case 'rmarkdown::run': {
                reg = /(?<=http:\/\/)[0-9.:]*/g;
                break;
            }
            // the inf_mr output url is of the structure:
            // http://127.0.0.1:port/path/to/file.html
            case 'xaringan::inf_mr' || 'xaringan::infinite_moon_reader': {
                reg = /(?<=http:\/\/)(.*)(?=\.html)/g;
                break;
            }
            default: break;
        }


        if (this.openProcesses.some(e => e.file === fileName)) {
            this.openProcesses.filter(e => e.file === fileName)[0].panel.reveal();
        } else {
            try {
                call = cp.spawn(cmd, null, { shell: true });
            } catch (e) {
                console.error((e as unknown).toString());
            }

            (call as cp.ChildProcessWithoutNullStreams).stderr.on('data',
                (data: Buffer) => {
                    const dat = data.toString('utf8');
                    const match = reg.exec(dat)?.[0];
                    const previewUrl = previewEngine === 'rmarkdown::run' ? `http://${match}/${fileName}` : `http://${match}.html`;
                    if (match) {
                        void this.showPreview(previewUrl, fileName, call, viewer, fileUri);
                    }
                });
        }
    }

    public refreshPanel(): void {
        if (this.activePreview) {
            this.activePreview.webview.html = '';
            this.activePreview.webview.html = getBrowserHtml(this.activeExternalResource);
        }
    }

    public async showSource(): Promise<void> {
        if (this.activeResource) {
            const viewCol = vscode.window.visibleTextEditors.filter(e => e.document.uri === this.activeResource)[0]?.viewColumn;
            await vscode.commands.executeCommand('vscode.open', this.activeResource, {
                preserveFocus: false,
                preview: false,
                viewColumn: viewCol ?? vscode.ViewColumn.Active
            });
        }
    }

    public openExternal(): void {
        if (this.activeExternalResource) {
            void vscode.env.openExternal(this.activeExternalResource);
        }
    }

    private async showPreview(url: string, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, fileUri: vscode.Uri): Promise<void> {
        console.info(`[showPreview] uri: ${url}`);
        const uri = vscode.Uri.parse(url);
        const externalUri = await vscode.env.asExternalUri(uri);
        const panel = vscode.window.createWebviewPanel(
            'previewRmd',
            `Preview ${title}`,
            {
                preserveFocus: true,
                viewColumn: viewer
            },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true,
            });

        this.openProcesses.push(
            {
                cp: cp,
                file: title,
                panel: panel
            }
        );

        if (isHost()) {
            await shareBrowser(url, title);
        }

        panel.onDidDispose(() => {
            // destroy process on closing window
            kill(cp.pid);

            void vscode.commands.executeCommand('setContext', 'r.preview.active', false);
            for (const [key, item] of this.openProcesses.entries()) {
                if (item.file === title) {
                    this.openProcesses.splice(key, 1);
                }
            }

            if (isHost()) {
                closeBrowser(url);
            }
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void vscode.commands.executeCommand('setContext', 'r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview = webviewPanel;
                this.activeResource = fileUri;
                this.activeExternalResource = externalUri;
            }
        });

        panel.webview.html = getBrowserHtml(externalUri);
    }

}
