/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { QuickPickItem, QuickPickOptions, Uri, window, workspace } from 'vscode';
import { extensionContext } from '../extension';
import { exec, executeRCommand, getCurrentWorkspaceFolder, getRpath, ToRStringLiteral } from '../util';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

interface TemplateInfo {
  id: string;
  package: string;
  name: string;
  description: string;
  create_dir: boolean;
}

interface TemplateItem extends QuickPickItem {
  info: TemplateInfo;
}

async function getTemplateItems(cwd: string): Promise<TemplateItem[]> {
  const lim = '---vsc---';
  const rPath = await getRpath();
  const options: cp.ExecSyncOptionsWithStringEncoding = {
    cwd: cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      VSCR_LIM: lim
    }
  };

  const rScriptFile = extensionContext.asAbsolutePath('R/rmarkdown/templates.R');
  const args = [
    '--silent',
    '--slave',
    '--no-save',
    '--no-restore',
    '-f',
    rScriptFile
  ];

  return new Promise((resolve) => {
    try {
      let str = '';
      const childProcess = exec(rPath, args, options);
      childProcess.stdout?.on('data', (chunk: Buffer) => {
        str += chunk.toString();
      });
      childProcess.on('exit', (code, signal) => {
        let items: TemplateItem[] = [];
        if (code === 0) {
          const re = new RegExp(`${lim}(.*)${lim}`, 'ms');
          const match = re.exec(str);
          if (match.length === 2) {
            const json = match[1];
            const templates = <TemplateInfo[]>JSON.parse(json) || [];
            items = templates.map((x) => {
              return {
                alwaysShow: false,
                description: `{${x.package}}`,
                label: x.name,
                detail: x.description,
                picked: false,
                info: x
              };
            });
          } else {
            console.log('Could not parse R output.');
          }
        } else {
          console.log(`R process exited with code ${code} from signal ${signal}`);
        }
        resolve(items);
      });
    } catch (e) {
      void window.showErrorMessage((<{ message: string }>e).message);
      resolve([]);
    }
  });
}

async function launchTemplatePicker(cwd: string): Promise<TemplateItem> {
  const options: QuickPickOptions = {
    matchOnDescription: true,
    matchOnDetail: true,
    canPickMany: false,
    ignoreFocusOut: false,
    placeHolder: '',
    onDidSelectItem: undefined
  };

  const items = await getTemplateItems(cwd);

  const selection: TemplateItem = await window.showQuickPick<TemplateItem>(items, options);
  return selection;
}

async function makeDraft(file: string, template: TemplateItem, cwd: string): Promise<string> {
  const fileString = ToRStringLiteral(file, '');
  const cmd = `cat(normalizePath(rmarkdown::draft(file='${fileString}', template='${template.info.id}', package='${template.info.package}', edit=FALSE)))`;
  return await executeRCommand(cmd, cwd, (e: Error) => {
    void window.showErrorMessage(e.message);
    return '';
  });
}

export async function newDraft(): Promise<void> {
  const cwd = getCurrentWorkspaceFolder()?.uri.fsPath ?? os.homedir();
  const template = await launchTemplatePicker(cwd);
  if (!template) {
    return;
  }

  if (template.info.create_dir) {
    const uri = await window.showSaveDialog({
      defaultUri: Uri.file(join(cwd, 'draft')),
      filters: {
        'R Markdown': ['Rmd', 'rmd']
      },
      saveLabel: 'Create Folder',
      title: 'R Markdown: New Draft'
    });

    if (uri) {
      const draftPath = await makeDraft(uri.fsPath, template, cwd);
      if (draftPath) {
        await workspace.openTextDocument(draftPath)
          .then(document => window.showTextDocument(document));
      }
    }
  } else {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-R-'));
    const tempFile = path.join(tempDir, 'draft.Rmd');
    const draftPath = await makeDraft(tempFile, template, cwd);
    if (draftPath) {
      const text = fs.readFileSync(draftPath, 'utf8');
      await workspace.openTextDocument({ language: 'rmd', content: text })
        .then(document => window.showTextDocument(document));
    }
    fs.rmdirSync(tempDir, { recursive: true });
  }
}
