import { Uri, window } from 'vscode';
import * as yaml from 'js-yaml';
import * as fs from 'fs-extra';
import { getOnDiskWorkspaceFolders, showAndLogErrorMessage, showAndLogInformationMessage } from './helpers';
import { Credentials } from './authentication';
import * as cli from './cli';
import { logger } from './logging';

interface Config {
  repositories: string[];
  ref?: string;
  language?: string;
}

// Test "controller" repository and workflow.
const OWNER = 'dsp-testing';
const REPO = 'qc-controller';

/**
 * Finds the language that a query targets.
 * If it can't be autodetected, prompt the user to specify the language manually.
 */
export async function findLanguage(
  cliServer: cli.CodeQLCliServer,
  queryUri: Uri | undefined
): Promise<string | undefined> {
  const uri = queryUri || window.activeTextEditor?.document.uri;
  if (uri !== undefined) {
    try {
      const queryInfo = await cliServer.resolveQueryByLanguage(getOnDiskWorkspaceFolders(), uri);
      const language = (Object.keys(queryInfo.byLanguage))[0];
      void logger.log(`Detected query language: ${language}`);
      return language;
    } catch (e) {
      void logger.log('Could not autodetect query language. Select language manually.');
    }
  }
  const availableLanguages = Object.keys(await cliServer.resolveLanguages());
  const language = await window.showQuickPick(
    availableLanguages,
    { placeHolder: 'Select target language for your query', ignoreFocusOut: true }
  );
  if (!language) {
    // This only happens if the user cancels the quick pick.
    void showAndLogErrorMessage('Language not found. Language must be specified manually.');
  }
  return language;
}

export async function runRemoteQuery(cliServer: cli.CodeQLCliServer, credentials: Credentials, uri?: Uri) {
  if (!uri?.fsPath.endsWith('.ql')) {
    return;
  }

  const octokit = await credentials.getOctokit();
  const token = await credentials.getToken();

  const queryFile = uri.fsPath;
  const query = await fs.readFile(queryFile, 'utf8');

  const repositoriesFile = queryFile.substring(0, queryFile.length - '.ql'.length) + '.repositories';
  if (!(await fs.pathExists(repositoriesFile))) {
    void showAndLogErrorMessage(`Missing file: '${repositoriesFile}' to specify the repositories to run against. This file must be a sibling of ${queryFile}.`);
    return;
  }

  const config = yaml.safeLoad(await fs.readFile(repositoriesFile, 'utf8')) as Config;

  const ref = config.ref || 'main';
  const language = config.language || await findLanguage(cliServer, uri);
  const repositories = config.repositories;

  if (!language) {
    return; // No error message needed, since `findlanguage` already displays one.
  }

  try {
    await octokit.request(
      'POST /repos/:owner/:repo/code-scanning/codeql/queries',
      {
        owner: OWNER,
        repo: REPO,
        data: {
          ref: ref,
          language: language,
          repositories: repositories,
          query: query,
          token: token,
        }
      }
    );
    void showAndLogInformationMessage(`Successfully scheduled runs. [Click here to see the progress](https://github.com/${OWNER}/${REPO}/actions).`);

  } catch (error) {
    void showAndLogErrorMessage(error);
  }
}
