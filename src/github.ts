import * as vscode from 'vscode';

export interface Actor {
  login: string;
  isBot: boolean;
  avatarUrl?: string;
}

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  reviewDecision: string | null;
  /** SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null */
  checks: string | null;
  author: Actor;
  /** Everyone seen on the PR except the viewer. */
  participants: Actor[];
  /** Author of the most recent comment or review. */
  lastActor?: Actor;
  lastActorIsViewer: boolean;
  /** Head branch lives in a fork. */
  isCrossRepository: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE */
  mergeState: string;
  /** Comments and reviews by anyone but the viewer, oldest first. */
  othersActivity: { login: string; at: string }[];
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface ThreadItem {
  author: Actor;
  bodyHTML: string;
  createdAt: string;
  url: string;
  state?: string;
  inline: { path: string; line: number | null; bodyHTML: string; author: Actor }[];
}

export class SignedOutError extends Error {
  constructor() {
    super('Not signed in to GitHub');
  }
}

export async function getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession('github', ['repo'], { createIfNone });
}

async function token(): Promise<string> {
  const session = await getSession(false);
  if (!session) {
    throw new SignedOutError();
  }
  return session.accessToken;
}

async function rest(path: string, opts: { method?: string; body?: unknown; accept?: string } = {}): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'task-inbox-vscode',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await rest('/graphql', { method: 'POST', body: { query, variables } });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!json.data) {
    throw new Error(`GitHub GraphQL: ${json.errors?.map(e => e.message).join('; ') ?? 'no data'}`);
  }
  return json.data;
}

type RawActor = { login: string; __typename: string; avatarUrl?: string } | null;

function actor(a: RawActor): Actor {
  return a
    ? { login: a.login, isBot: a.__typename === 'Bot', avatarUrl: a.avatarUrl }
    : { login: 'ghost', isBot: false };
}

const ACTOR = 'login __typename avatarUrl';

export async function fetchMyPrs(owner: string, repo: string): Promise<PullRequest[]> {
  const data = await graphql<any>(
    `query($q: String!) {
      viewer { login }
      search(query: $q, type: ISSUE, first: 50) {
        nodes {
          ... on PullRequest {
            number title url isDraft updatedAt
            headRefName baseRefName headRefOid baseRefOid
            reviewDecision isCrossRepository mergeable mergeStateStatus
            author { ${ACTOR} }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            comments(last: 50) { nodes { author { ${ACTOR} } createdAt } }
            reviews(last: 50) { nodes { author { ${ACTOR} } createdAt } }
            reviewRequests(first: 20) {
              nodes { requestedReviewer { __typename ... on Bot { login } ... on User { login } } }
            }
          }
        }
      }
    }`,
    { q: `repo:${owner}/${repo} is:pr is:open author:@me sort:updated-desc` },
  );
  const viewer: string = data.viewer.login;
  return (data.search.nodes as any[])
    .filter(n => n?.number)
    .map(n => {
      const activity: { author: RawActor; createdAt: string }[] = [...n.comments.nodes, ...n.reviews.nodes]
        .filter(Boolean)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const requested: RawActor[] = n.reviewRequests.nodes
        .map((r: any) => r?.requestedReviewer)
        .filter((r: any) => r?.login);
      const seen = new Map<string, Actor>();
      for (const raw of [n.author, ...activity.map(a => a.author), ...requested]) {
        const a = actor(raw);
        if (raw && a.login !== viewer) {
          seen.set(a.login, a);
        }
      }
      const last = activity.at(-1);
      return {
        owner,
        repo,
        number: n.number,
        title: n.title,
        url: n.url,
        isDraft: n.isDraft,
        updatedAt: n.updatedAt,
        headRefName: n.headRefName,
        baseRefName: n.baseRefName,
        headRefOid: n.headRefOid,
        baseRefOid: n.baseRefOid,
        reviewDecision: n.reviewDecision,
        checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
        author: actor(n.author),
        participants: [...seen.values()],
        lastActor: last ? actor(last.author) : undefined,
        lastActorIsViewer: last?.author?.login === viewer,
        isCrossRepository: n.isCrossRepository,
        mergeable: n.mergeable,
        mergeState: n.mergeStateStatus,
        othersActivity: activity
          .filter(a => a.author && a.author.login !== viewer)
          .map(a => ({ login: a.author!.login, at: a.createdAt })),
      } satisfies PullRequest;
    });
}

export async function fetchChanges(pr: PullRequest): Promise<{ base: string; files: ChangedFile[] }> {
  const repoPath = `/repos/${pr.owner}/${pr.repo}`;
  const mergeBase = rest(`${repoPath}/compare/${pr.baseRefOid}...${pr.headRefOid}?per_page=1`)
    .then(r => r.json() as Promise<any>)
    .then(j => (j.merge_base_commit?.sha as string | undefined) ?? pr.baseRefOid);
  const files: ChangedFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = (await (await rest(`${repoPath}/pulls/${pr.number}/files?per_page=100&page=${page}`)).json()) as ChangedFile[];
    files.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return { base: await mergeBase, files };
}

export async function fetchFile(owner: string, repo: string, sha: string, path: string): Promise<string> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await rest(`/repos/${owner}/${repo}/contents/${encoded}?ref=${sha}`, {
    accept: 'application/vnd.github.raw',
  });
  return res.text();
}

export async function fetchThread(pr: PullRequest): Promise<ThreadItem[]> {
  const data = await graphql<any>(
    `query($o: String!, $r: String!, $n: Int!) {
      repository(owner: $o, name: $r) {
        pullRequest(number: $n) {
          comments(last: 60) { nodes { author { ${ACTOR} } bodyHTML createdAt url } }
          reviews(last: 40) {
            nodes {
              author { ${ACTOR} } bodyHTML state createdAt url
              comments(first: 30) { nodes { path line originalLine bodyHTML author { ${ACTOR} } } }
            }
          }
        }
      }
    }`,
    { o: pr.owner, r: pr.repo, n: pr.number },
  );
  const p = data.repository.pullRequest;
  const items: ThreadItem[] = [
    ...p.comments.nodes.filter(Boolean).map((c: any) => ({
      author: actor(c.author),
      bodyHTML: c.bodyHTML,
      createdAt: c.createdAt,
      url: c.url,
      inline: [],
    })),
    ...p.reviews.nodes.filter(Boolean).map((r: any) => ({
      author: actor(r.author),
      bodyHTML: r.bodyHTML,
      createdAt: r.createdAt,
      url: r.url,
      state: r.state,
      inline: r.comments.nodes.filter(Boolean).map((c: any) => ({
        path: c.path,
        line: c.line ?? c.originalLine ?? null,
        bodyHTML: c.bodyHTML,
        author: actor(c.author),
      })),
    })),
  ];
  return items
    .filter(i => i.bodyHTML || i.inline.length || (i.state && i.state !== 'COMMENTED'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function postComment(pr: PullRequest, body: string): Promise<void> {
  await rest(`/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { method: 'POST', body: { body } });
}
