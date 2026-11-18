# Privacy

Last updated: 18 November 2026.

This page describes what the Cold Read app does with data, as the code in this repository does it. Cold Read runs on Atlassian's Forge platform; what Atlassian itself processes is covered by Atlassian's own privacy policy.

## What the app reads

Every Confluence and Jira request runs as the person using the app, so the app reads only what that person can see:

- the page being checked: its title, version, owner, space and body (converted to plain text), and whether the person can edit it;
- for a warm read: up to 5 related pages found by Confluence search, with their body, and up to 5 Jira issues found by Jira search, with their descriptions and comments;
- for a Jira issue about A findings: the Jira projects where the person can create issues, and their issue types;
- for the space page: the pages that have Cold Read data, read the same way, so pages the person cannot see are left out.

Each step of a cold read reads the page as the person who calls it, so only someone who can view the page can take the step.

## What the app stores

The app keeps its data in the Forge Key-Value Store of the installation, hosted by Atlassian for the site where the app is installed:

- the questions of a page and their expected answers, and when they were saved;
- runs: page ID, title and version; the questions and expected answers as they were at the run; the Cold Reader's answers with quotes from the page; findings with notes; the warm-read search words and the titles and IDs or keys of the related pages and issues; when the run started, was answered and was checked; for the Jira issue about the run, its key, link, whether it was assigned, the number of A findings and when it was created;
- for each space, the Jira project last used for Cold Read issues.

The app does not store Atlassian account IDs or profile data such as names, email addresses or avatars, and it does not store the full page text. To assign a Jira issue to the page owner, the app passes the owner's account ID from Confluence to Jira in that request and does not keep it. The account ID inside a user mention on a page is dropped: the mention reaches the Cold Reader as its link text, or as `@user` if it has none. A mention in a Jira description or comment reaches it as the name Jira shows.

Titles, questions, expected answers, quotes and notes are free text. They can contain whatever the page or the people who wrote them say, including names.

What the latest finished run stores, including the titles of the related pages and issues that the person who ran it could see, is shown in the Cold Read panel to everyone who can view the page. `get-cold-read-status` returns its findings with their questions and notes, its Jira issue key and link, its status and when it finished.

The app writes page and run IDs, Jira issue keys, counts, the warm-read search words (words from the page title) and Jira error messages to the Forge app logs, not page text. Forge shows app logs to the app developer in the Atlassian developer console, unless a site admin turns off log access for the app.

## What leaves the site

- Nothing goes to servers of the app's author: the manifest declares no external hosts, and the app calls no model of its own.
- The Cold Reader is a Rovo agent and runs on the site's Rovo, Atlassian's AI. Rovo gets what the app's actions return to it: the page text and the questions, then the expected answers or, for a warm read, the text of the related pages and Jira issues.
- MCP: once a site admin turns on "Expose tools to MCP-compatible apps", a person on the site can connect an MCP client with their own Atlassian sign-in. The five Cold Read tools then return to that client the page text, the questions, the expected answers (after the answers are saved), the related pages and issues, and the findings and Jira issue key of the latest run. The client may pass them to its model provider.
- Jira: a Cold Read issue is created as the person who clicks, assigned to the page owner where the project allows it, and holds the A findings with their questions and notes, the page title and version, and a link to the page. Jira shows it to whoever can see the project.

## How to remove the data

- A page editor removes the saved questions of a page with **Use the handoff set** in the Cold Read panel.
- The app does not delete runs. Uninstalling the app removes its storage for the site; Atlassian keeps a soft-deleted copy for its retention period, as described in Forge's "Data lifecycle for Forge-hosted storage".
- Cold Read issues are ordinary Jira issues and are deleted in Jira.

## Contact

Open an issue at https://github.com/works-on-my-box/cold-read/issues.
