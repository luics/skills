import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';

const BASE_URL = 'https://www.transfermarkt.com/spieler-statistik/wertvollstespieler/marktwertetop';
const MAX_PAGE = 20;
const MAX_LIMIT = 25;

function positiveInteger(value, defaultValue, label, maximum) {
  const number = Number(value ?? defaultValue);
  if (!Number.isInteger(number) || number < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  if (number > maximum) {
    throw new ArgumentError(`${label} must be <= ${maximum}`);
  }
  return number;
}

cli({
  site: 'transfermarkt',
  name: 'top-players',
  description: 'List the world’s most valuable players from Transfermarkt’s visible ranking table',
  access: 'read',
  example: 'opencli transfermarkt top-players --page 1 --limit 25 -f yaml',
  domain: 'www.transfermarkt.com',
  strategy: Strategy.UI,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'page', type: 'int', default: 1, help: 'Ranking page (1-20)' },
    { name: 'limit', type: 'int', default: 25, help: 'Rows to return (1-25)' },
  ],
  columns: ['rank', 'playerName', 'playerId', 'position', 'age', 'nationalities', 'club', 'clubId', 'marketValueDisplay', 'marketValueEur', 'playerUrl'],
  func: async (page, kwargs) => {
    const pageNumber = positiveInteger(kwargs.page, 1, 'page', MAX_PAGE);
    const limit = positiveInteger(kwargs.limit, 25, 'limit', MAX_LIMIT);
    const url = pageNumber === 1 ? BASE_URL : `${BASE_URL}?page=${pageNumber}`;

    try {
      await page.goto(url);
      await page.wait({ selector: 'table.items > tbody > tr', timeout: 10 });
    } catch (error) {
      if (/timeout|timed out/i.test(String(error?.message ?? error))) {
        throw new TimeoutError('Transfermarkt ranking table', 10);
      }
      throw new CommandExecutionError(`Could not open Transfermarkt ranking: ${error?.message ?? error}`);
    }

    const rows = await page.evaluate(`(() => {
      const toId = (href) => href?.match(/\\/spieler\\/(\\d+)/)?.[1] ?? null;
      const toClubId = (href) => href?.match(/\\/verein\\/(\\d+)/)?.[1] ?? null;
      const toValueEur = (text) => {
        const match = text.match(/€([\\d.]+)([mk])?/i);
        if (!match) return null;
        const amount = Number(match[1]);
        const unit = match[2]?.toLowerCase();
        return Number.isFinite(amount) ? amount * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1) : null;
      };
      return [...document.querySelectorAll('table.items > tbody > tr')]
        .map((row) => {
          const cells = row.cells;
          const playerLink = cells[1]?.querySelector('a[href*="/profil/spieler/"]');
          const clubLink = cells[4]?.querySelector('a[href*="/verein/"]');
          const valueLink = cells[5]?.querySelector('a[href*="/marktwertverlauf/spieler/"]');
          const displayValue = valueLink?.textContent?.trim() ?? '';
          return {
            rank: Number(cells[0]?.textContent?.trim()),
            playerName: playerLink?.textContent?.trim() ?? '',
            playerId: toId(playerLink?.getAttribute('href')),
            position: cells[1]?.querySelector('.inline-table tr:nth-child(2) td')?.textContent?.trim() ?? '',
            age: Number(cells[2]?.textContent?.trim()),
            nationalities: [...(cells[3]?.querySelectorAll('img[title]') ?? [])].map((flag) => flag.getAttribute('title')).filter(Boolean).join(', '),
            club: clubLink?.getAttribute('title')?.trim() ?? '',
            clubId: toClubId(clubLink?.getAttribute('href')),
            marketValueDisplay: displayValue,
            marketValueEur: toValueEur(displayValue),
            playerUrl: playerLink ? new URL(playerLink.getAttribute('href'), location.origin).href : '',
          };
        })
        .filter((row) => Number.isInteger(row.rank) && row.playerName && row.playerId && row.marketValueEur !== null);
    })()`);

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new EmptyResultError('transfermarkt top-players', `No ranking rows found on page ${pageNumber}`);
    }
    return rows.slice(0, limit);
  },
});
