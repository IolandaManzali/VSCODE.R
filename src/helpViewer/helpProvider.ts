/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Memento, window } from 'vscode';
import * as http from 'http';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import * as rHelp from '.';
import { extensionContext } from '../extension';
import { DisposableProcess, spawn } from '../util';
import { readJSON } from 'fs-extra';

export interface RHelpProviderOptions {
	// path of the R executable
    rPath: string;
	// directory in which to launch R processes
	cwd?: string;
    // listener to notify when new packages are installed
    pkgListener?: () => void;
}

type ChildProcessWithPort = DisposableProcess & {
    port?: number | Promise<number>;
};

// Class to forward help requests to a backgorund R instance that is running a help server
export class HelpProvider {
    private cp: ChildProcessWithPort;
    private readonly rPath: string;
    private readonly cwd?: string;
    private readonly pkgListener?: () => void;

    public constructor(options: RHelpProviderOptions){
        this.rPath = options.rPath || 'R';
        this.cwd = options.cwd;
        this.pkgListener = options.pkgListener;
        this.cp = this.launchRHelpServer();
    }

    public async refresh(): Promise<void> {
        this.cp.dispose();
        this.cp = this.launchRHelpServer();
        await this.cp.port;
    }

    public launchRHelpServer(): ChildProcessWithPort{
		const lim = '---vsc---';
		const portRegex = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
        
        const newPackageRegex = new RegExp('NEW_PACKAGES');

        // starts the background help server and waits forever to keep the R process running
        const scriptPath = extensionContext.asAbsolutePath('R/help/helpServer.R');
        // const cmd = `${this.rPath} --silent --slave --no-save --no-restore -f "${scriptPath}"`;
        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-f',
            scriptPath
        ];
        const cpOptions = {
            cwd: this.cwd,
            env: { ...process.env, 'VSCR_LIM': lim },
        };

        const childProcess: ChildProcessWithPort = spawn(this.rPath, args, cpOptions);

        let str = '';
        // promise containing the port number of the process (or 0)
        const portPromise = new Promise<number>((resolve) => {
            childProcess.stdout?.on('data', (data) => {
                try{
                    // eslint-disable-next-line
                    str += data.toString();
                } catch(e){
                    resolve(0);
                }
                if(portRegex.exec(str)){
                    resolve(Number(str.replace(portRegex, '$1')));
                    str = str.replace(portRegex, '');
                }
                if(newPackageRegex.exec(str)){
                    this.pkgListener?.();
                    str = str.replace(newPackageRegex, '');
                }
            });
            childProcess.on('close', () => {
                resolve(0);
            });
        });
        
        const exitHandler = () => {
            childProcess.port = 0;
        };
        childProcess.on('exit', exitHandler);
        childProcess.on('error', exitHandler);

        // await and store port number
        childProcess.port = portPromise;

        // is returned as a promise if not called with "await":
        return childProcess;
    }

	public async getHelpFileFromRequestPath(requestPath: string): Promise<undefined|rHelp.HelpFile> {

        const port = await this.cp?.port;
        if(!port || typeof port !== 'number'){
            return undefined;
        }

        // remove leading '/'
        while(requestPath.startsWith('/')){
            requestPath = requestPath.substr(1);
        }

        interface HtmlResult {
            content?: string,
            redirect?: string
        }

        // forward request to R instance
        // below is just a complicated way of getting a http response from the help server
        let url = `http://localhost:${port}/${requestPath}`;
        let html = '';
        const maxForwards = 3;
        for (let index = 0; index < maxForwards; index++) {
            const htmlPromise = new Promise<HtmlResult>((resolve, reject) => {
                let content = '';
                http.get(url, (res: http.IncomingMessage) => {
                    if(res.statusCode === 302){
                        resolve({redirect: res.headers.location});
                    } else{
                        res.on('data', (chunk) => {
                            try{
                                // eslint-disable-next-line
                                content += chunk.toString();
                            } catch(e){
                                reject();
                            }
                        });
                        res.on('close', () => {
                            resolve({content: content});
                        });
                        res.on('error', () => {
                            reject();
                        });
                    }
                });
            });
            const htmlResult = await htmlPromise;
            if(htmlResult.redirect){
                const newUrl = new URL(htmlResult.redirect, url);
                requestPath = newUrl.pathname;
                url = newUrl.toString();
            } else{
                html = htmlResult.content || '';
                break;
            }
        }

        // return help file
        const ret: rHelp.HelpFile = {
            requestPath: requestPath,
            html: html,
            isRealFile: false,
            url: url
        };
        return ret;
    }


    dispose(): void {
        this.cp.dispose();
    }
}


export interface AliasProviderArgs {
	// R path, must be vanilla R
	rPath: string;
    // cwd
    cwd?: string;
	// getAliases.R
    rScriptFile: string;

    persistentState: Memento;
}

interface PackageAliases {
    package?: string;
    libPath?: string;
    aliasFile?: string;
    aliases?: {
        [key: string]: string;
    }
}
interface AllPackageAliases {
    [key: string]: PackageAliases
}

// Implements the aliasProvider required by the help panel
export class AliasProvider {

    private readonly rPath: string;
    private readonly cwd?: string;
    private readonly rScriptFile: string;
    private aliases?: undefined | rHelp.Alias[];
	private readonly persistentState?: Memento;

    constructor(args: AliasProviderArgs){
        this.rPath = args.rPath;
        this.cwd = args.cwd;
        this.rScriptFile = args.rScriptFile;
        this.persistentState = args.persistentState;
    }

    // delete stored aliases, will be generated on next request
    public async refresh(): Promise<void> {
        this.aliases = undefined;
        await this.persistentState?.update('r.helpPanel.cachedAliases', undefined);
        await this.makeAllAliases();
    }

    // get a list of all aliases
    public async getAllAliases(): Promise<rHelp.Alias[] | undefined> {
        // try this.aliases:
        if(this.aliases){
            return this.aliases;
        }
        
        // try cached aliases:
        const cachedAliases = this.persistentState?.get<rHelp.Alias[]>('r.helpPanel.cachedAliases');
        if(cachedAliases){
            this.aliases = cachedAliases;
            return cachedAliases;
        }
        
        // try to make new aliases (returns undefined if unsuccessful):
        const newAliases = await this.makeAllAliases();
        this.aliases = newAliases;
        this.persistentState?.update('r.helpPanel.cachedAliases', newAliases);
        return newAliases;
    }

    // converts aliases grouped by package to a flat list of aliases
    private async makeAllAliases(): Promise<rHelp.Alias[] | undefined> {
        // get aliases from R (nested format)
        const allPackageAliases = await this.getAliasesFromR();
        if(!allPackageAliases){
            return undefined;
        }
        
        // flatten aliases into one list:
        const allAliases: rHelp.Alias[] = [];
        for(const pkg in allPackageAliases){
            const pkgName = allPackageAliases[pkg].package || pkg;
            const pkgAliases = allPackageAliases[pkg].aliases || {};
            for(const fncName in pkgAliases){
                allAliases.push({
                    name: fncName,
                    alias: pkgAliases[fncName],
                    package: pkgName
                });
            }
        }
        return allAliases;
    }

    // call R script `getAliases.R` and parse the output
    private async getAliasesFromR(): Promise<undefined | AllPackageAliases> {
        const lim = '---vsc---';
        const options: cp.ExecSyncOptionsWithStringEncoding = {
            cwd: this.cwd,
            encoding: 'utf-8',
            env: {
                ...process.env,
                VSCR_LIM: lim
            }
        };

        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-f',
            this.rScriptFile
        ];

        return new Promise((resolve) => {
            try {
                let str = '';
                const childProcess = spawn(this.rPath, args, options);
                childProcess.stdout?.on('data', (chunk: Buffer) => {
                    str += chunk.toString();
                });
                childProcess.on('exit', (code, signal) => {
                    let result: AllPackageAliases | undefined = undefined;
                    if (code === 0) {
                        const re = new RegExp(`${lim}(.*)${lim}`, 'ms');
                        const match = re.exec(str);
                        if (match.length === 2) {
                            const json = match[1];
                            result = <{ [key: string]: PackageAliases }>JSON.parse(json) || {};
                        } else {
                            console.log('Could not parse R output.');
                        }
                    } else {
                        console.log(`R process exited with code ${code} from signal ${signal}`);
                    }
                    resolve(result);
                });
            } catch (e) {
                console.log(e);
                void window.showErrorMessage((<{ message: string }>e).message);
                resolve(undefined);
            }
        });
    }
}
