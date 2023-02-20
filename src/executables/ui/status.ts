import * as vscode from 'vscode';

import { isVirtual } from '../service/class';
import { RExecutableService } from '../service';

enum BinText {
    name = 'R Language Indicator',
    missing = '$(warning) Select R executable'
}

export class ExecutableStatusItem implements vscode.Disposable {
    private readonly service: RExecutableService;
    private languageStatusItem!: vscode.LanguageStatusItem;

    private createItem(): vscode.LanguageStatusItem {
        this.languageStatusItem = vscode.languages.createLanguageStatusItem('R Executable Selector', ['r', 'rmd', 'rProfile']);
        this.languageStatusItem.name = 'R Language Service';
        this.languageStatusItem.command = {
            'title': 'Select R executable',
            'command': 'r.setExecutable'
        };
        this.refresh();
        return this.languageStatusItem;
    }

    public constructor(service: RExecutableService) {
        this.service = service;
        this.createItem();
    }

    public get text(): string {
        return this.languageStatusItem.text;
    }

    public get busy(): boolean {
        return this.languageStatusItem.busy;
    }

    public get severity(): vscode.LanguageStatusSeverity {
        return this.languageStatusItem.severity;
    }

    public refresh(): void {
        const execState = this.service?.activeExecutable;
        if (execState) {
            this.languageStatusItem.severity = vscode.LanguageStatusSeverity.Information;
            this.languageStatusItem.detail = execState.rBin;
            if (isVirtual(execState)) {
                const versionString = execState.rVersion ? ` (${execState.rVersion})` : '';
                const name = execState.name ? execState.name : '';
                this.languageStatusItem.text = `${name}${versionString}`;
            } else {
                this.languageStatusItem.text = execState.rVersion;
            }
        } else {
            this.languageStatusItem.severity = vscode.LanguageStatusSeverity.Warning;
            this.languageStatusItem.text = BinText.missing;
            this.languageStatusItem.detail = '';
        }
    }

    public async makeBusy(prom: Promise<void>): Promise<void> {
        this.languageStatusItem.busy = true;
        await prom.catch(() => {
            this.languageStatusItem.severity = vscode.LanguageStatusSeverity.Error;
            this.languageStatusItem.detail = '$(error) Error activating virtual environment';
        }).finally(() => {
            this.languageStatusItem.busy = false;
        });
    }

    public dispose(): void {
        this.languageStatusItem.dispose();
    }

}
