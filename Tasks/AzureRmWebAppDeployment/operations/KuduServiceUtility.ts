import tl = require('vsts-task-lib/task');
import Q = require('q');
import path = require('path');
import { Kudu } from 'azure-arm-rest/azure-arm-app-service-kudu';
import { KUDU_DEPLOYMENT_CONSTANTS } from 'azure-arm-rest/constants';
import webClient = require('azure-arm-rest/webClient');
import { TaskParameters } from './TaskParameters';
var deployUtility = require('webdeployment-common/utility.js');
var zipUtility = require('webdeployment-common/ziputility.js');
const physicalRootPath: string = '/site/wwwroot';

export class KuduServiceUtility {
    private _appServiceKuduService: Kudu;
    private _deploymentID: string;

    constructor(kuduService: Kudu) {
        this._appServiceKuduService = kuduService;
    }

    public async createPathIfRequired(phsyicalPath: string): Promise<void> {
        var listDir = await this._appServiceKuduService.listDir(phsyicalPath);
        if(listDir == null) {
            await this._appServiceKuduService.createPath(phsyicalPath);
        }
    }

    public async updateDeploymentStatus(taskResult: boolean, DeploymentID: string, customMessage: any): Promise<void> {
        try {
            var requestBody = this._getUpdateHistoryRequest(taskResult, DeploymentID, customMessage);
            await this._appServiceKuduService.updateDeployment(requestBody);
        }
        catch(error) {
            tl.warning(error);
        }
    }

    public async runPostDeploymentScript(taskParams: TaskParameters): Promise<void> {
        try {
            if(taskParams.TakeAppOfflineFlag) {
                await this._appOfflineKuduService(physicalRootPath, true);
            }

            var scriptFile = this._getPostDeploymentScript(taskParams.ScriptType, taskParams.InlineScript, taskParams.ScriptPath, taskParams.isLinuxApp);
            var uniqueID = this.getDeploymentID();
            var fileExtension : string = taskParams.isLinuxApp ? '.sh' : '.cmd';
            var mainCmdFilePath = path.join(__dirname, '..', 'postDeploymentScript', 'mainCmdFile' + fileExtension);
            await this._appServiceKuduService.uploadFile(physicalRootPath, 'mainCmdFile_' + uniqueID + fileExtension, mainCmdFilePath);
            await this._appServiceKuduService.uploadFile(physicalRootPath, 'kuduPostDeploymentScript_' + uniqueID + fileExtension, scriptFile.filePath);
            console.log(tl.loc('ExecuteScriptOnKudu'));
            await this.runCommand('site\\wwwroot',
             'mainCmdFile_' + uniqueID + fileExtension + ' ' + uniqueID,
              30, 'script_result_' +  uniqueID + '.txt');
            await this._printPostDeploymentLogs(physicalRootPath, uniqueID);

        }
        catch(error) {
            throw Error(tl.loc('FailedToRunScriptOnKuduError', error));
        }
        finally {
            try {
                await this._appServiceKuduService.uploadFile(physicalRootPath, 'delete_log_file_' + uniqueID + fileExtension, path.join(__dirname, '..', 'postDeploymentScript', 'deleteLogFile' + fileExtension));
                await this.runCommand('site\\wwwroot', 'delete_log_file_' + uniqueID + fileExtension + ' ' + uniqueID, 0, null);
            }
            catch(error) {
                tl.debug('Unable to delete log files : ' + error);
            }
            if(taskParams.TakeAppOfflineFlag) {
                await this._appOfflineKuduService(physicalRootPath, false);
            }
        }
    }

    public getDeploymentID(): string {
        if(this._deploymentID) {
            return this._deploymentID;
        }

        var buildUrl = tl.getVariable('build.buildUri');
        var releaseUrl = tl.getVariable('release.releaseUri');
    
        var buildId = tl.getVariable('build.buildId');
        var releaseId = tl.getVariable('release.releaseId');
        
        var buildNumber = tl.getVariable('build.buildNumber');
        var releaseName = tl.getVariable('release.releaseName');
    
        var collectionUrl = tl.getVariable('system.TeamFoundationCollectionUri'); 
        var teamProject = tl.getVariable('system.teamProjectId');
    
         var commitId = tl.getVariable('build.sourceVersion');
         var repoName = tl.getVariable('build.repository.name');
         var repoProvider = tl.getVariable('build.repository.provider');
    
        var buildOrReleaseUrl = "" ;
        var deploymentID: string = (releaseId ? releaseId : buildId) + Date.now().toString();
        return deploymentID;
    }

    public async deployWebPackage(packagePath: string, physicalPath: string, virtualPath: string, appOffline: boolean): Promise<void> {
        physicalPath = physicalPath ? physicalPath : physicalRootPath;
        try {
            if(appOffline) {
                await this._appOfflineKuduService(physicalPath, true);
                tl.debug('Wait for 10 seconds for app_offline to take effect');
                await webClient.sleepFor(10);
            }

            if(tl.stats(packagePath).isDirectory()) {
                let tempPackagePath = deployUtility.generateTemporaryFolderOrZipPath(tl.getVariable('AGENT.TEMPDIRECTORY'), false);
                packagePath = await zipUtility.archiveFolder(packagePath, "", tempPackagePath);
                tl.debug("Compressed folder " + packagePath + " into zip : " +  packagePath);
            }
            else if(packagePath.toLowerCase().endsWith('.war')) {
                physicalPath = await this._warFileDeployment(packagePath, physicalPath, virtualPath);
            }

            await this._appServiceKuduService.extractZIP(packagePath, physicalPath);
            if(appOffline) {
                await this._appOfflineKuduService(physicalPath, false);
            }

            console.log(tl.loc("Successfullydeployedpackageusingkuduserviceat", packagePath, physicalPath));
        }
        catch(error) {
            tl.error(tl.loc('PackageDeploymentFailed'));
            throw Error(error);
        }
    }

    private async _printPostDeploymentLogs(physicalPath: string, uniqueID: string) : Promise<void> {
        var stdoutLog = await this._appServiceKuduService.getFileContent(physicalPath, 'stdout_' + uniqueID + '.txt');
        var stderrLog = await this._appServiceKuduService.getFileContent(physicalPath, 'stderr_' + uniqueID + '.txt');
        var scriptReturnCode = await this._appServiceKuduService.getFileContent(physicalPath, 'script_result_' + uniqueID + '.txt');

        if(scriptReturnCode == null) {
            throw new Error('File not found in Kudu Service. ' + 'script_result_' + uniqueID + '.txt');
        }

        if(stdoutLog) {
            console.log(tl.loc('stdoutFromScript'));
            console.log(stdoutLog);
        }
        if(stderrLog) {
            console.log(tl.loc('stderrFromScript'));
            if(scriptReturnCode != '0') {
                tl.error(stderrLog);
                throw Error(tl.loc('ScriptExecutionOnKuduFailed', scriptReturnCode, stderrLog));
            }
            else {
                console.log(stderrLog);
            }
        }
    }

    private async runCommand(physicalPath: string, command: string, timeOutInMinutes: number, pollFile: string): Promise<void> {
        try {
            await this._appServiceKuduService.runCommand(physicalPath, command);
        }
        catch(error) {
            if(timeOutInMinutes > 0 && error.toString().indexOf('Request timeout: /api/command') != -1) {
                tl.debug('Request timeout occurs. Trying to poll for file: ' + pollFile);
                await this._pollForFile(physicalPath, pollFile, timeOutInMinutes);
            }
            else {
                if(typeof error.valueOf() == 'string') {
                    throw error;
                }

                throw `${error.statusCode} - ${error.statusMessage}`;
            }
        }
    }

    private _getPostDeploymentScript(scriptType, inlineScript, scriptPath, isLinux): any {
        if(scriptType === 'Inline Script') {
            tl.debug('creating kuduPostDeploymentScript_local file');
            var scriptFilePath = path.join(tl.getVariable('AGENT.TEMPDIRECTORY'), isLinux ? 'kuduPostDeploymentScript_local.sh' : 'kuduPostDeploymentScript_local.cmd');
            tl.writeFile(scriptFilePath, inlineScript);
            tl.debug('Created temporary script file : ' + scriptFilePath);
            return {
                "filePath": scriptFilePath,
                "isCreated": true
            };
        }
        if(!tl.exist(scriptPath)) {
            throw Error(tl.loc('ScriptFileNotFound', scriptPath));
        }
        var scriptExtension = path.extname(scriptPath);
        if(isLinux){
            if(scriptExtension != '.sh'){
                throw Error(tl.loc('InvalidScriptFile', scriptPath));
            }
        } else {
            if(scriptExtension != '.bat' && scriptExtension != '.cmd') {
                throw Error(tl.loc('InvalidScriptFile', scriptPath));
            }
        }
        tl.debug('postDeployment script path to execute : ' + scriptPath);
        return {
            filePath: scriptPath,
            isCreated: false
        }
    }

    private async _warFileDeployment(packagePath: string, physicalPath: string, virtualPath?: string): Promise<string> {
        tl.debug('WAR: webAppPackage = ' + packagePath);
        let warFile = path.basename(packagePath.slice(0, packagePath.length - '.war'.length));
        let warExt = packagePath.slice(packagePath.length - '.war'.length)
        tl.debug('WAR: warFile = ' + warFile);
        warFile = warFile + ((virtualPath) ? "/" + virtualPath : "");
        tl.debug('WAR: warFile = ' + warFile);
        physicalPath = physicalPath + "/webapps/" + warFile;
        await this.createPathIfRequired(physicalPath);
        return physicalPath;

    }

    private async _appOfflineKuduService(physicalPath: string, enableFeature: boolean): Promise<void> {
        if(enableFeature) {
            tl.debug('Trying to enable app offline mode.');
            var appOfflineFilePath = path.join(tl.getVariable('AGENT.TEMPDIRECTORY'), 'app_offline_temp.htm');
            tl.writeFile(appOfflineFilePath, '<h1>App Service is offline.</h1>');
            await this._appServiceKuduService.uploadFile(physicalPath, 'app_offline.htm', appOfflineFilePath);
            tl.debug('App Offline mode enabled.');
        }
        else {
            tl.debug('Trying to disable app offline mode.');
            await this._appServiceKuduService.deleteFile(physicalPath, 'app_offline.htm');
            tl.debug('App Offline mode disabled.');
        }
    }

    private async _pollForFile(physicalPath: string, fileName: string, timeOutInMinutes: number): Promise<void> {
        var attempts: number = 0;
        const retryInterval: number = 10;
        if(tl.getVariable('appservicedeploy.retrytimeout')) {
            timeOutInMinutes = Number(tl.getVariable('appservicedeploy.retrytimeout'));
            tl.debug('Retry timeout in minutes provided by user: ' + timeOutInMinutes);
        }

        var timeOutInSeconds = timeOutInMinutes * 60;
        var noOfRetry = timeOutInSeconds / retryInterval;

        tl.debug(`Polling started for file:  ${fileName} with retry count: ${noOfRetry}`);

        while (attempts < noOfRetry) {
            attempts += 1;
            var fileContent: string = await this._appServiceKuduService.getFileContent(physicalPath, fileName);
            if(fileContent == null) {
                tl.debug('File: ' + fileName + ' not found. retry after 10 seconds. Attempt: ' + attempts);
                await webClient.sleepFor(10);
            }
            else {
                tl.debug('Found file:  ' + fileName);
                return ;
            }
        }

        if(attempts == noOfRetry) {
            throw new Error(tl.loc('ScriptStatusTimeout'));
        }
    }

    private _getUpdateHistoryRequest(isDeploymentSuccess: boolean, deploymentID?: string, customMessage?: any): any {
        
        var status = isDeploymentSuccess ? KUDU_DEPLOYMENT_CONSTANTS.SUCCESS : KUDU_DEPLOYMENT_CONSTANTS.FAILED;
        var author = tl.getVariable('build.sourceVersionAuthor') || tl.getVariable('build.requestedfor') ||
                            tl.getVariable('release.requestedfor') || tl.getVariable('agent.name')
    
        var buildUrl = tl.getVariable('build.buildUri');
        var releaseUrl = tl.getVariable('release.releaseUri');
    
        var buildId = tl.getVariable('build.buildId');
        var releaseId = tl.getVariable('release.releaseId');
        
        var buildNumber = tl.getVariable('build.buildNumber');
        var releaseName = tl.getVariable('release.releaseName');
    
        var collectionUrl = tl.getVariable('system.TeamFoundationCollectionUri'); 
        var teamProject = tl.getVariable('system.teamProjectId');
    
         var commitId = tl.getVariable('build.sourceVersion');
         var repoName = tl.getVariable('build.repository.name');
         var repoProvider = tl.getVariable('build.repository.provider');
    
        var buildOrReleaseUrl = "" ;
        deploymentID = !!deploymentID ? deploymentID : this.getDeploymentID();

        if(releaseUrl !== undefined) {
            buildOrReleaseUrl = collectionUrl + teamProject + "/_apps/hub/ms.vss-releaseManagement-web.hub-explorer?releaseId=" + releaseId + "&_a=release-summary";
        }
        else if(buildUrl !== undefined) {
            buildOrReleaseUrl = collectionUrl + teamProject + "/_build?buildId=" + buildId + "&_a=summary";
        }
    
        var message = {
            type : customMessage? customMessage.type : "",
            commitId : commitId,
            buildId : buildId,
            releaseId : releaseId,
            buildNumber : buildNumber,
            releaseName : releaseName,
            repoProvider : repoProvider,
            repoName : repoName,
            collectionUrl : collectionUrl,
            teamProject : teamProject
        };
        // Append Custom Messages to original message
        for(var attribute in customMessage) {
            message[attribute] = customMessage[attribute];
        }
    
        var deploymentLogType: string = message['type'];
        var active: boolean = false;
        if(deploymentLogType.toLowerCase() === "deployment" && isDeploymentSuccess) {
            active = true;
        }
    
        return {
            id: deploymentID,
            active : active,
            status : status,
            message : JSON.stringify(message),
            author : author,
            deployer : 'VSTS',
            details : buildOrReleaseUrl
        };
    }
}