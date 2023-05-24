import { faker } from "@faker-js/faker";
import fs from "node:fs/promises";
import gh from "parse-github-url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { ShowcaseScraper } from "../scripts/libs/showcaseScrapper";

// Define a mock query function that will be used by the GraphQL client during the test to return fake data.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

// Mock the entire GraphQL client to avoid hitting the GitHub API.
vi.mock("@octokit/graphql", () => ({ default: { graphql: { defaults: () => queryMock } } }));

// Mock the fs module to avoid writing showcase files to the file system during tests.
vi.mock("node:fs/promises");

beforeAll(() => {
  // Set a fake GitHub token as it's required by the scrapper.
  vi.stubEnv("GITHUB_TOKEN", "test-fake-token");

  // Prevent informative logs from the scrapper to be displayed during tests.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("should collect links", async () => {
  const author_1 = faker.internet.userName();
  const author_1_links = [faker.internet.url(), faker.internet.url()];
  const author_2 = faker.internet.userName();
  const author_2_links: string[] = [];
  const author_3 = faker.internet.userName();
  const author_3_links = [faker.internet.url()];

  const scraper = getTestScrapper([
    { author: author_1, links: author_1_links },
    { author: author_2, links: author_2_links },
    { author: author_3, links: author_3_links },
  ]);

  const showcases = await scraper.run();

  expect(showcases).toHaveLength(2);

  const showcase_1 = showcases.at(0);
  const showcase_2 = showcases.at(1);

  expect(showcase_1?.author).toBe(author_1);
  expect(showcase_1?.links).toHaveLength(2);
  expect(showcase_1?.links).toMatchObject(author_1_links.map((link) => ({ url: link, type: "unknown" })));

  expect(showcase_2?.author).toBe(author_3);
  expect(showcase_2?.links).toHaveLength(1);
  expect(showcase_2?.links).toMatchObject(author_3_links.map((link) => ({ url: link, type: "unknown" })));
});

test("should identify GitHub links", async () => {
  const link = "http://github.com/user";

  const scraper = getTestScrapper([[link]]);

  const showcases = await scraper.run();

  expect(showcases.at(0)?.links).toMatchObject([{ url: link, type: "github" }]);
});

test("should identify GitHub repo links", async () => {
  const link = "http://github.com/user/repo";

  const scraper = getTestScrapper([[link]]);

  const showcases = await scraper.run();

  expect(showcases.at(0)?.links).toMatchObject([{ url: link, type: "github_repo" }]);
});

test("should collect links from the same user spread across multiple comments", async () => {
  const author = faker.internet.userName();
  const author_comment_1_links = [faker.internet.url()];
  const author_comment_2_links = [faker.internet.url(), faker.internet.url()];

  const scraper = getTestScrapper([
    { author: author, links: author_comment_1_links },
    [faker.internet.url()],
    { author: author, links: author_comment_2_links },
  ]);

  const showcases = await scraper.run();

  expect(showcases.at(0)?.author).toBe(author);
  expect(showcases.at(0)?.links).toHaveLength(3);
  expect(showcases.at(0)?.links).toMatchObject(
    [...author_comment_1_links, ...author_comment_2_links].map((link) => ({ url: link, type: "unknown" }))
  );
});

test("should delete the existing showcase content collection before saving showcases to handle deleted comments", async () => {
  const scraper = getTestScrapper([[faker.internet.url(), faker.internet.url()]]);

  const rmMock = vi.mocked(fs.rm).mockReset();
  const mkdirMock = vi.mocked(fs.mkdir).mockReset();
  const writeFileMock = vi.mocked(fs.writeFile).mockReset();

  await scraper.run();

  expect(rmMock).toHaveBeenCalledOnce();
  expect(mkdirMock).toHaveBeenCalledOnce();
  expect(writeFileMock).toHaveBeenCalledOnce();
  expect(rmMock.mock.invocationCallOrder < mkdirMock.mock.invocationCallOrder).toBe(true);
  expect(mkdirMock.mock.invocationCallOrder < writeFileMock.mock.invocationCallOrder).toBe(true);
});

test("should save a showcase file per user", async () => {
  const author_1 = faker.internet.userName();
  const author_1_links = [faker.internet.url(), faker.internet.url()];
  const author_2 = faker.internet.userName();
  const author_2_links = [faker.internet.url()];

  const scraper = getTestScrapper([
    { author: author_1, links: author_1_links },
    { author: author_2, links: author_2_links },
  ]);

  const writeFileMock = vi.mocked(fs.writeFile).mockReset();

  const showcases = await scraper.run();

  expect(writeFileMock).toHaveBeenCalledTimes(2);
  expect(writeFileMock).toHaveBeenNthCalledWith(
    1,
    `src/content/showcase/${author_1}.json`,
    JSON.stringify(showcases.at(0), null, 2),
    "utf8"
  );
  expect(writeFileMock).toHaveBeenNthCalledWith(
    2,
    `src/content/showcase/${author_2}.json`,
    JSON.stringify(showcases.at(1), null, 2),
    "utf8"
  );
});

/**
 * Return a test instance of the ShowcaseScraper class which will use the provided comments links as the data source.
 *
 * It takes an array of comments links as input, and each comment can be either a flat array of links or an object with
 * the comment author and an array of links.
 *
 * - To generate two comments with various links:
 *
 * ```ts
 * getTestScrapper([
 *  ["http://comment1-link1.com", "http://comment1-link2.com"],
 *  ["http://comment2-link1.com", "http://comment2-link2.com"],
 * ]);
 * ```
 *
 * - To generate two comments with various links and authors:
 *
 * ```ts
 * getTestScrapper([
 *  { author: "comment1-author", links: ["http://comment1-link1.com", "http://comment1-link2.com"] },
 *  { author: "comment2-author", links: ["http://comment2-link1.com", "http://comment2-link2.com"] },
 * ]);
 * ```
 *
 * Note that both approaches can be mixed.
 */
function getTestScrapper(commentsLinks: TestCommentLinks[]) {
  const scraper = new ShowcaseScraper("test-org", "test-repo", 0, []);

  let ghRepoLinks: { name: string; owner: string; url: string }[] = [];

  const commentsNodes = commentsLinks.map((commentLinks, commentIndex) => {
    const isFlatLinks = Array.isArray(commentLinks);
    const author = isFlatLinks ? `test-user-${commentIndex}` : commentLinks.author;
    const links = isFlatLinks ? commentLinks : commentLinks.links;

    return {
      author: { login: author },
      bodyHTML: links
        .map((link) => {
          const ghLink = gh(link);

          if (ghLink?.name && ghLink?.owner) {
            ghRepoLinks.push({ name: ghLink.name, owner: ghLink.owner, url: link });
          }

          return `<a href="${link}">${link}</a>`;
        })
        .join(" "),
    };
  });

  // Mock the GraphQL query returning the discussion comments.
  queryMock.mockReturnValueOnce({
    repository: {
      discussion: {
        bodyHTML: "Test discussion body",
        comments: { pageInfo: { endCursor: "end-cursor", hasNextPage: false }, nodes: commentsNodes },
      },
    },
  });

  // Each GitHub repository link will trigger a GraphQL query to fetch the repository data so we mock each of them.
  for (const ghRepoLink of ghRepoLinks) {
    queryMock.mockReturnValueOnce({
      repository: {
        description: faker.lorem.paragraph(),
        discussions: { totalCount: getTestRepoStatCount() },
        forkCount: getTestRepoStatCount(),
        issues: { totalCount: getTestRepoStatCount() },
        mentionableUsers: { totalCount: getTestRepoStatCount() },
        name: ghRepoLink.name,
        owner: { avatarUrl: faker.image.url(), login: ghRepoLink.owner },
        pullRequests: { totalCount: getTestRepoStatCount() },
        stargazerCount: getTestRepoStatCount(),
        url: ghRepoLink.url,
      },
    });
  }

  return scraper;
}

function getTestRepoStatCount() {
  return faker.number.int(10_000);
}

type TestCommentLinks = string[] | { author?: string; links: string[] };
