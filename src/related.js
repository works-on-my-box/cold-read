// The sources of the warm read, shared by the agent action get-warm-read-packet and the one-click run (src/sources.js):
// the Jira issues and pages the page links to. They are read as the user, so the reader never gets more than the
// person can see.
import { fetchPage, pageByTitle } from './confluence';
import { fetchIssue, canSeeIssue } from './jira';
import { makeFindRelated, makeForViewer } from './sources';

export const findRelated = makeFindRelated({ fetchPage, fetchIssue, pageByTitle });

// A run as the person who asks may see it: without what came with the linked sources they cannot open.
export const forViewer = makeForViewer({ fetchPage, canSeeIssue });
