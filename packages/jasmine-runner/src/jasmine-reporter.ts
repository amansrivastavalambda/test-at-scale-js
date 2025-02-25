import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
    ExecutionResult,
    ID,
    TASDate as Date,
    Task,
    TestResult,
    TestStatus,
    TestSuiteResult,
    Util
} from "@lambdatest/test-at-scale-core";

export class CustomReporter implements jasmine.CustomReporter {
    private ancestorTitles: string[] = [];
    private specStartTime = new Date();
    private suiteStartTime = new Date();
    private _coverageMap: Map<string, typeof global.__coverage__> = new Map<string, typeof global.__coverage__>();

    private _runTask: Task<ExecutionResult>
    // Need to keep this as of 2 types because jasmine typings have inconsistencies
    // in type of `id` for jasmine.Spec (number) vs for jasmine.SpecResult (string).
    // So, for reporters string is typed whereas for topSuite it is of type number.
    private _entityIdFilenameMap: Map<number | string, string>

    private repoID = process.env.REPO_ID as ID;
    private executionResults = new ExecutionResult();

    constructor(runTask: Task<ExecutionResult>, entityIdFilenameMap: Map<number | string, string>) {
        this._runTask = runTask;
        this._entityIdFilenameMap = entityIdFilenameMap;
    }

    suiteStarted(result: jasmine.SuiteResult): void {
        this.suiteStartTime = new Date();
        this.ancestorTitles.push(result.description);
    }

    suiteDone(result: jasmine.SuiteResult): void {
        // instead of "passed", suite returns "finished"
        if (result.status === "finished") {
            result.status = TestStatus.Passed;
        }
        // @types/jasmine has a bug where `id` in Reporters are string vs `id` in topSuite
        const filename = this._entityIdFilenameMap.get(result.id) ?? "";
        const suiteIdentifier = Util.getIdentifier(filename, result.description);
        const suiteIdentifiers = this.ancestorTitles
            .map((suiteName) => Util.getIdentifier(filename, suiteName));
        const parentSuiteIdentifiers = suiteIdentifiers.slice(0, -1);
        const duration: number = result.duration ?? ((new Date()).getTime() - this.suiteStartTime.getTime())
        const locator = Util.getLocator(filename, this.ancestorTitles, result.description);
        const blockTest = Util.getBlockTestLocatorProperties(locator);
        if (blockTest.isBlocked) {
            result.status = Util.getTestStatus(blockTest.status)
        }
        const testSuite = new TestSuiteResult(
            crypto
                .createHash("md5")
                .update(this.repoID + "\n" + suiteIdentifiers.join("\n"))
                .digest("hex"),
            suiteIdentifier,
            parentSuiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(this.repoID + "\n" + parentSuiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            duration,
            result.status as TestStatus,
            blockTest.isBlocked,
            blockTest.source,
            this.suiteStartTime
        )
        this.executionResults.testSuiteResults.push(testSuite);
        this.ancestorTitles.pop();

        if (filename && global.__coverage__) {
            this._coverageMap.set(filename, global.__coverage__);
        }
    }

    specStarted(): void {
        this.specStartTime = new Date();
    }

    specDone(result: jasmine.SpecResult): void {
        const filename = this._entityIdFilenameMap.get(result.id) ?? "";
        const suiteIdentifiers = this.ancestorTitles
            .map((suiteName) => Util.getIdentifier(filename, suiteName));
        const testIdentifier = Util.getIdentifier(filename, result.description);
        const locator = Util.getLocator(filename, this.ancestorTitles, result.description);
        const blockTest = Util.getBlockTestLocatorProperties(locator);
        // if test is blocked change status as per type i.e blocklisted or quarantined or skipped etc
        if (blockTest.isBlocked) {
            result.status = Util.getTestStatus(blockTest.status);
        } else { 
           // get test status
           result.status = Util.getTestStatus(result.status)
        }
        let failureMessage: string | null = null;
        if (result.status === TestStatus.Failed) {
            failureMessage = result.failedExpectations
                .map(failedExpectation => failedExpectation.stack || failedExpectation.message).join('\n\n')
        }
        let duration = 0;
        if (result.status === TestStatus.Passed || result.status === TestStatus.Failed) {
            duration = result.duration ?? ((new Date()).getTime() - this.specStartTime.getTime());
        }
        const test = new TestResult(
            crypto
                .createHash("md5")
                .update(this.repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                .digest("hex"),
            testIdentifier,
            result.description,
            suiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(this.repoID + "\n" + suiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            locator,
            duration,
            result.status as TestStatus,
            blockTest.isBlocked,
            blockTest.source,
            this.specStartTime,
            failureMessage
        );
        this.executionResults.testResults.push(test);
    }

    jasmineDone(): void {
        const CODE_COVERAGE_DIR = process.env.CODE_COVERAGE_DIR as string;
        if (CODE_COVERAGE_DIR) {
            for (const [filename, coverage] of this._coverageMap) {
                const coverageFileName = `${CODE_COVERAGE_DIR}/${filename.replace(/\//g, '')}/coverage-final.json`;
                // Ensure output path exists
                fs.mkdirSync(path.dirname(coverageFileName), { recursive: true });
                // Write data to file
                fs.writeFileSync(coverageFileName, JSON.stringify(coverage));
            }
        }
        this._runTask.resolve(this.executionResults);
    }
}
