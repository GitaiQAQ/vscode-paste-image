'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import { spawn } from 'child_process';
import * as moment from 'moment';
import * as upath from 'upath';

class Logger {
    static channel: vscode.OutputChannel;

    static log(message: any) {
        if (this.channel) {
            let time = moment().format("MM-DD HH:mm:ss");
            this.channel.appendLine(`[${time}] ${message}`);
        }
    }

    static showInformationMessage(message: string, ...items: string[]): Thenable<string> {
        this.log(message);
        return vscode.window.showInformationMessage(message, ...items);
    }

    static showErrorMessage(message: string, ...items: string[]): Thenable<string> {
        this.log(message);
        return vscode.window.showErrorMessage(message, ...items);
    }
}

export function activate(context: vscode.ExtensionContext) {
    Logger.channel = vscode.window.createOutputChannel("PasteImage")
    context.subscriptions.push(Logger.channel);

    Logger.log('Congratulations, your extension "vscode-paste-image" is now active!');

    let disposable = vscode.commands.registerCommand('extension.pasteImage', () => {
        try {
            Paster.paste();
        } catch (e) {
            Logger.showErrorMessage(e)
        }
    });

    context.subscriptions.push(disposable);

    return {
        extendMarkdownIt(md: any) {
            return md.use((md, options) => {
                const image_ = md.renderer.rules.image;
                md.renderer.rules.image = function (tokens, idx, options, env, self) {
                    let html = image_(tokens, idx, options, env, self);
                    if ( /\$res/.test(html)) {
                        let editor = vscode.window.activeTextEditor;
                        if (!editor) return;

                        let fileUri = editor.document.uri;
                        if (!fileUri) return;
                        if (fileUri.scheme === 'untitled') {
                            Logger.showInformationMessage('Before paste image, you need to save current edit file first.');
                            return;
                        }
                        let filePath = fileUri.fsPath;

                        let ext = path.extname(filePath);
                        let fileName = path.basename(filePath);
                        let fileNameWithoutExt = path.basename(filePath, ext);

                        html = html.replace(/\$res/g, fileNameWithoutExt + ".resource");
                    }
                    return html;
                  }
                
            });
        }
    }
}

export function deactivate() {
}

class Paster {
    static PATH_VARIABLE_CURRNET_FILE_DIR = /\$\{currentFileDir\}/;
    static PATH_VARIABLE_PROJECT_ROOT = /\$\{projectRoot\}/;
    static PATH_VARIABLE_CURRNET_FILE_NAME = /\$\{currentFileName\}/;
    static PATH_VARIABLE_CURRNET_FILE_NAME_WITHOUT_EXT = /\$\{currentFileNameWithoutExt\}/;

    static folderPathFromConfig: string;
    static basePathFromConfig: string;
    static prefixFromConfig: string;
    static suffixFromConfig: string;
    static forceUnixStyleSeparatorFromConfig: boolean;

    public static paste() {
        // get current edit file path
        let editor = vscode.window.activeTextEditor;
        if (!editor) return;

        let fileUri = editor.document.uri;
        if (!fileUri) return;
        if (fileUri.scheme === 'untitled') {
            Logger.showInformationMessage('Before paste image, you need to save current edit file first.');
            return;
        }
        let filePath = fileUri.fsPath;
        let folderPath = path.dirname(filePath);
        let projectPath = vscode.workspace.rootPath;

        // get selection as image file name, need check
        var selection = editor.selection;
        var selectText = editor.document.getText(selection);
        if (selectText && /[\\:*?<>|]/.test(selectText)) {
            Logger.showInformationMessage('Your selection is not a valid file name!');
            return;
        }

        // load config pasteImage.path/pasteImage.basePath
        this.folderPathFromConfig = vscode.workspace.getConfiguration('pasteImage')['path'];
        if (!this.folderPathFromConfig) {
            this.folderPathFromConfig = "${currentFileDir}";
        }
        if (this.folderPathFromConfig.length !== this.folderPathFromConfig.trim().length) {
            Logger.showErrorMessage(`The config pasteImage.path = '${this.folderPathFromConfig}' is invalid. please check your config.`);
            return;
        }
        this.basePathFromConfig = vscode.workspace.getConfiguration('pasteImage')['basePath'];
        if (!this.basePathFromConfig) {
            this.basePathFromConfig = "";
        }
        if (this.basePathFromConfig.length !== this.basePathFromConfig.trim().length) {
            Logger.showErrorMessage(`The config pasteImage.path = '${this.basePathFromConfig}' is invalid. please check your config.`);
            return;
        }
        this.prefixFromConfig = vscode.workspace.getConfiguration('pasteImage')['prefix'];
        this.suffixFromConfig = vscode.workspace.getConfiguration('pasteImage')['suffix'];
        this.forceUnixStyleSeparatorFromConfig = vscode.workspace.getConfiguration('pasteImage')['forceUnixStyleSeparator'];
        this.forceUnixStyleSeparatorFromConfig = !!this.forceUnixStyleSeparatorFromConfig;

        this.folderPathFromConfig = this.replacePathVariable(this.folderPathFromConfig, projectPath, filePath);
        this.basePathFromConfig = this.replacePathVariable(this.basePathFromConfig, projectPath, filePath);

        let imagePath = this.getImagePath(filePath, selectText, this.folderPathFromConfig);

        try {
            // is the file existed?
            let existed = fs.existsSync(imagePath);
            if (existed) {
                Logger.showInformationMessage(`File ${imagePath} existed.Would you want to replace?`, 'Replace', 'Cancel').then(choose => {
                    if (choose != 'Replace') return;

                    this.saveAndPaste(editor, imagePath);
                });
            } else {
                this.saveAndPaste(editor, imagePath);
            }
        } catch (err) {
            Logger.showErrorMessage(`fs.existsSync(${imagePath}) fail. message=${err.message}`);
            return;
        }
    }

    public static saveAndPaste(editor: vscode.TextEditor, imagePath) {
        this.createImageDirWithImagePath(imagePath).then(imagePath => {
            // save image and insert to current edit file
            this.saveClipboardImageToFileAndGetPath(imagePath, (imagePath, imagePathReturnByScript) => {
                if (!imagePathReturnByScript) return;
                if (imagePathReturnByScript === 'no image') {
                    Logger.showInformationMessage('There is not a image in clipboard.');
                    return;
                }

                imagePath = this.renderFilePath(editor.document.languageId, this.basePathFromConfig, this.replace2Variable(imagePath), this.forceUnixStyleSeparatorFromConfig, this.prefixFromConfig, this.suffixFromConfig);

                editor.edit(edit => {
                    let current = editor.selection;

                    if (current.isEmpty) {
                        edit.insert(current.start, imagePath);
                    } else {
                        edit.replace(current, imagePath);
                    }
                });
            });
        }).catch(err => {
            if (err instanceof PluginError) {
                Logger.showErrorMessage(err.message);
            } else {
                Logger.showErrorMessage(`Failed make folder. message=${err.message}`);
            }
            return;
        });
    }

    public static getImagePath(filePath: string, selectText: string, folderPathFromConfig: string): string {
        // image file name
        let imageFileName = "";
        if (!selectText) {
            imageFileName = moment().format("Y-MM-DD-HH-mm-ss") + ".png";
        } else {
            imageFileName = selectText.replace(/\s?/g, "_") + ".png";
        }

        // image output path
        let folderPath = path.dirname(filePath);
        let imagePath = "";

        // generate image path
        if (path.isAbsolute(folderPathFromConfig)) {
            imagePath = path.join(folderPathFromConfig, imageFileName);
        } else {
            imagePath = path.join(folderPath, folderPathFromConfig, imageFileName);
        }

        return imagePath;
    }

    /**
     * create directory for image when directory does not exist
     */
    private static createImageDirWithImagePath(imagePath: string) {
        return new Promise((resolve, reject) => {
            let imageDir = path.dirname(imagePath);

            fs.stat(imageDir, (err, stats) => {
                if (err == null) {
                    if (stats.isDirectory()) {
                        resolve(imagePath);
                    } else {
                        reject(new PluginError(`The image dest directory '${imageDir}' is a file. please check your 'pasteImage.path' config.`))
                    }
                } else if (err.code == "ENOENT") {
                    fse.ensureDir(imageDir, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve(imagePath);
                    });
                } else {
                    reject(err);
                }
            });
        });
    }

    /**
     * use applescript to save image from clipboard and get file path
     */
    private static saveClipboardImageToFileAndGetPath(imagePath, cb: (imagePath: string, imagePathFromScript: string) => void) {
        if (!imagePath) return;

        let platform = process.platform;
        if (platform === 'win32') {
            // Windows
            const scriptPath = path.join(__dirname, '../../res/pc.ps1');

            let command = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            let powershellExisted = fs.existsSync(command)
            if (!powershellExisted) {
                command = "powershell"
            }

            const powershell = spawn(command, [
                '-noprofile',
                '-noninteractive',
                '-nologo',
                '-sta',
                '-executionpolicy', 'unrestricted',
                '-windowstyle', 'hidden',
                '-file', scriptPath,
                imagePath
            ]);
            powershell.on('error', function (e) {
                if (e.code == "ENOENT") {
                    Logger.showErrorMessage(`The powershell command is not in you PATH environment variables.Please add it and retry.`);
                } else {
                    Logger.showErrorMessage(e);
                }
            });
            powershell.on('exit', function (code, signal) {
                // console.log('exit', code, signal);
            });
            powershell.stdout.on('data', function (data: Buffer) {
                cb(imagePath, data.toString().trim());
            });
        }
        else if (platform === 'darwin') {
            // Mac
            let scriptPath = path.join(__dirname, '../../res/mac.applescript');

            let ascript = spawn('osascript', [scriptPath, imagePath]);
            ascript.on('error', function (e) {
                Logger.showErrorMessage(e);
            });
            ascript.on('exit', function (code, signal) {
                // console.log('exit',code,signal);
            });
            ascript.stdout.on('data', function (data: Buffer) {
                cb(imagePath, data.toString().trim());
            });
        } else {
            // Linux 

            let scriptPath = path.join(__dirname, '../../res/linux.sh');

            let ascript = spawn('sh', [scriptPath, imagePath]);
            ascript.on('error', function (e) {
                Logger.showErrorMessage(e);
            });
            ascript.on('exit', function (code, signal) {
                // console.log('exit',code,signal);
            });
            ascript.stdout.on('data', function (data: Buffer) {
                let result = data.toString().trim();
                if (result == "no xclip") {
                    Logger.showInformationMessage('You need to install xclip command first.');
                    return;
                }
                cb(imagePath, result);
            });
        }
    }

    /**
     * render the image file path dependen on file type
     * e.g. in markdown image file path will render to ![](path)
     */
    public static renderFilePath(languageId: string, basePath: string, imageFilePath: string, forceUnixStyleSeparator: boolean, prefix: string, suffix: string): string {
        if (basePath && !imageFilePath.startsWith("$res")) {
            imageFilePath = path.relative(basePath, imageFilePath);
        }

        if (forceUnixStyleSeparator) {
            imageFilePath = upath.normalize(imageFilePath);
        }

        imageFilePath = `${prefix}${imageFilePath}${suffix}`;

        switch (languageId) {
            case "markdown":
                return `![](${imageFilePath})`
            case "asciidoc":
                return `image::${imageFilePath}[]`
            default:
                return imageFilePath;
        }
    }

    public static replacePathVariable(pathStr: string, projectRoot: string, curFilePath: string): string {
        let currentFileDir = path.dirname(curFilePath);
        let ext = path.extname(curFilePath);
        let fileName = path.basename(curFilePath);
        let fileNameWithoutExt = path.basename(curFilePath, ext);

        pathStr = pathStr.replace("$res", "./${currentFileNameWithoutExt}.resource");
        pathStr = pathStr.replace(this.PATH_VARIABLE_PROJECT_ROOT, projectRoot);
        pathStr = pathStr.replace(this.PATH_VARIABLE_CURRNET_FILE_DIR, currentFileDir);
        pathStr = pathStr.replace(this.PATH_VARIABLE_CURRNET_FILE_NAME, fileName);
        pathStr = pathStr.replace(this.PATH_VARIABLE_CURRNET_FILE_NAME_WITHOUT_EXT, fileNameWithoutExt);
        return pathStr;
    }

    public static replace2Variable(pathStr: string): string {
        pathStr = pathStr.replace(/^.*\.resource/, "$res");
        return pathStr;
    }
}

class PluginError {
    constructor(public message?: string) {
    }
}