const fs = require('fs');
const got = require('got');
const { promisify } = require('util');
const stream = require('stream');
const { delayPromise } = require('apify-shared/utilities');
const { ACT_JOB_TERMINAL_STATUSES } = require('apify-shared/consts');

const pipeline = promisify(stream.pipeline);

const WAIT_BETWEEN_REQUESTS = 100; // Time in ms to wait between request, to avoid rate limiting
const DEFAULT_POOLING_INTERVAL = 2000; // ms

/**
 * Asynchronously waits until execution is finished
 */
async function waitUntilExecutionFinished(executionId, crawlerClient, interval = DEFAULT_POOLING_INTERVAL) {
    let running = true;

    while (running) {
        const executionState = await crawlerClient.getExecutionDetails({ executionId });
        console.log(`Execution ${executionState.status}`);
        if (executionState.status !== 'RUNNING') {
            running = false;
        }
        await delayPromise(interval);
    }
}

/**
 * Asynchronously waits until run is finished
 */
async function waitUntilRunFinished(runId, actId, actsClient, interval = DEFAULT_POOLING_INTERVAL) {
    let running = true;
    let actRun;

    while (running) {
        actRun = await actsClient.getRun({ actId, runId });
        console.log(`Actor run ${actRun.status}`);
        if (ACT_JOB_TERMINAL_STATUSES.includes(actRun.status)) {
            running = false;
        }
        await delayPromise(interval);
    }
    return actRun;
}

/**
 * Appends csv result from crawler execution to file using pagination.
 * @param crawlerClient
 * @param executionResultsOpts
 * @param fileLimit
 * @param file
 * @param skipHeaderRow
 * @return {}
 */
async function saveResultsToFile(crawlerClient, executionResultsOpts, fileLimit, file, skipHeaderRow) {
    let fileResultsCount = 0;
    const fileWriteStream = fs.createWriteStream(file, { encoding: 'UTF-8', flags: 'a' });
    while (true) {
        console.log(`Saving ${executionResultsOpts.offset} - ${executionResultsOpts.offset + executionResultsOpts.limit} pages with results ...`);

        executionResultsOpts.skipHeaderRow = !(!skipHeaderRow && executionResultsOpts.offset === 0);

        const executionResults = await crawlerClient.getExecutionResults(executionResultsOpts);
        const resultCount = parseInt(executionResults.count, 10);

        if (resultCount === 0) break;

        // NOTE: clean spaces around string and add newline, without this we get malformed csv
        fileWriteStream.write(executionResults.items.trim());
        fileWriteStream.write('\n');

        fileResultsCount += resultCount;

        executionResultsOpts.offset += executionResultsOpts.limit;

        if (fileResultsCount >= fileLimit) break;

        await delayPromise(WAIT_BETWEEN_REQUESTS);
    }
    fileWriteStream.end();
    return executionResultsOpts;
}

/**
 * Appends csv items from dataset to file using pagination.
 * @param apifyDatasets
 * @param paginationItemsOpts
 * @param fileLimit
 * @param file
 * @param skipHeaderRow
 * @return {}
 */
async function saveItemsToFile(datasetId, paginationItemsOpts, fileLimit, file, skipHeaderRow) {
    paginationItemsOpts.limit = fileLimit;
    const fileWriteStream = fs.createWriteStream(file, { flags: 'a' });
    const datasetItemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items`;
    const datasetItemsStream = got.stream(datasetItemsUrl, {
        searchParams: { ...paginationItemsOpts, skipHeaderRow: skipHeaderRow ? '1' : '0' },
    });

    console.log(`Saving ${paginationItemsOpts.offset} - ${paginationItemsOpts.offset + paginationItemsOpts.limit} items ...`);

    await pipeline(
        datasetItemsStream,
        fileWriteStream,
    );

    paginationItemsOpts.offset += paginationItemsOpts.limit;

    return paginationItemsOpts;
}

function printLargeStringToStdOut(largeString) {
    // You can output in stdout only 64 000 bit in docker container (in plain nodejs process it works at all)
    const maxChunkLength = 50000;
    for (let i = 0; i < largeString.length; i += maxChunkLength) {
        process.stdout.write(largeString.substring(i, i + maxChunkLength));
    }
}

async function findDatasetByName(apifyDatasets, maybeDatasetName) {
    let datasetsPage;
    let offset = 0;
    const limit = 1000;
    while (true) {
        datasetsPage = await apifyDatasets.listDatasets({ limit, offset });
        const datasetByName = datasetsPage.items.find(maybeDataset => maybeDataset.name === maybeDatasetName);
        if (datasetByName) return datasetByName;
        if (datasetsPage.count === 0) return;
        offset += limit;
    }
}

const randomHostLikeString = () => `${Math.random().toString(36).substring(2)}-${Date.now().toString(36).substring(2)}`;

module.exports = {
    saveItemsToFile,
    saveResultsToFile,
    waitUntilExecutionFinished,
    waitUntilRunFinished,
    printLargeStringToStdOut,
    findDatasetByName,
    randomHostLikeString,
};
