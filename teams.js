/**
 * Every FBS team, so picking one costs nothing.
 *
 * The "My Dawgs" tab was Georgia, hardcoded: a --uga-red in the stylesheet, a
 * UGA_FALLBACK in the page, and a `fan/uga` document. That is the right shape
 * for one fan and the wrong shape for anyone else, so the tab is now "My
 * Team" and this is the list it picks from.
 *
 * A static list on purpose. A dropdown of 130-odd names is not worth a model
 * call, and a team's NAME and COLOURS do not change week to week - only its
 * record, its next game and what is being written about it do, and those are
 * what `fan/<id>` holds and what research refreshes.
 *
 * `id` is the Firestore document key under `fan/`, so it is stable and
 * lowercase. Georgia is `uga` rather than `georgia` deliberately: that
 * document already exists with real researched content in it, and renaming it
 * would throw that away to gain consistency nobody can see.
 *
 * `color` is the hero gradient and the accent on that team's tab. These are
 * approximations of the primary brand colour - close enough to feel right,
 * and worth correcting in place if one looks wrong. Nothing breaks if one is
 * off; it is decoration, not data.
 */

const TEAMS = [
  // --- SEC ---
  { id: 'uga', name: 'Georgia', mascot: 'Bulldogs', conf: 'SEC', color: '#BA0C2F' },
  { id: 'alabama', name: 'Alabama', mascot: 'Crimson Tide', conf: 'SEC', color: '#9E1B32' },
  { id: 'auburn', name: 'Auburn', mascot: 'Tigers', conf: 'SEC', color: '#0C2340' },
  { id: 'arkansas', name: 'Arkansas', mascot: 'Razorbacks', conf: 'SEC', color: '#9D2235' },
  { id: 'florida', name: 'Florida', mascot: 'Gators', conf: 'SEC', color: '#0021A5' },
  { id: 'kentucky', name: 'Kentucky', mascot: 'Wildcats', conf: 'SEC', color: '#0033A0' },
  { id: 'lsu', name: 'LSU', mascot: 'Tigers', conf: 'SEC', color: '#461D7C' },
  { id: 'mississippi-state', name: 'Mississippi State', mascot: 'Bulldogs', conf: 'SEC', color: '#5D1725' },
  { id: 'missouri', name: 'Missouri', mascot: 'Tigers', conf: 'SEC', color: '#F1B82D' },
  { id: 'oklahoma', name: 'Oklahoma', mascot: 'Sooners', conf: 'SEC', color: '#841617' },
  { id: 'ole-miss', name: 'Ole Miss', mascot: 'Rebels', conf: 'SEC', color: '#14213D' },
  { id: 'south-carolina', name: 'South Carolina', mascot: 'Gamecocks', conf: 'SEC', color: '#73000A' },
  { id: 'tennessee', name: 'Tennessee', mascot: 'Volunteers', conf: 'SEC', color: '#FF8200' },
  { id: 'texas', name: 'Texas', mascot: 'Longhorns', conf: 'SEC', color: '#BF5700' },
  { id: 'texas-am', name: 'Texas A&M', mascot: 'Aggies', conf: 'SEC', color: '#500000' },
  { id: 'vanderbilt', name: 'Vanderbilt', mascot: 'Commodores', conf: 'SEC', color: '#866D4B' },

  // --- Big Ten ---
  { id: 'illinois', name: 'Illinois', mascot: 'Fighting Illini', conf: 'Big Ten', color: '#13294B' },
  { id: 'indiana', name: 'Indiana', mascot: 'Hoosiers', conf: 'Big Ten', color: '#990000' },
  { id: 'iowa', name: 'Iowa', mascot: 'Hawkeyes', conf: 'Big Ten', color: '#FFCD00' },
  { id: 'maryland', name: 'Maryland', mascot: 'Terrapins', conf: 'Big Ten', color: '#E03A3E' },
  { id: 'michigan', name: 'Michigan', mascot: 'Wolverines', conf: 'Big Ten', color: '#00274C' },
  { id: 'michigan-state', name: 'Michigan State', mascot: 'Spartans', conf: 'Big Ten', color: '#18453B' },
  { id: 'minnesota', name: 'Minnesota', mascot: 'Golden Gophers', conf: 'Big Ten', color: '#7A0019' },
  { id: 'nebraska', name: 'Nebraska', mascot: 'Cornhuskers', conf: 'Big Ten', color: '#E41C38' },
  { id: 'northwestern', name: 'Northwestern', mascot: 'Wildcats', conf: 'Big Ten', color: '#4E2A84' },
  { id: 'ohio-state', name: 'Ohio State', mascot: 'Buckeyes', conf: 'Big Ten', color: '#BB0000' },
  { id: 'oregon', name: 'Oregon', mascot: 'Ducks', conf: 'Big Ten', color: '#154733' },
  { id: 'penn-state', name: 'Penn State', mascot: 'Nittany Lions', conf: 'Big Ten', color: '#041E42' },
  { id: 'purdue', name: 'Purdue', mascot: 'Boilermakers', conf: 'Big Ten', color: '#CEB888' },
  { id: 'rutgers', name: 'Rutgers', mascot: 'Scarlet Knights', conf: 'Big Ten', color: '#CC0033' },
  { id: 'ucla', name: 'UCLA', mascot: 'Bruins', conf: 'Big Ten', color: '#2D68C4' },
  { id: 'usc', name: 'USC', mascot: 'Trojans', conf: 'Big Ten', color: '#990000' },
  { id: 'washington', name: 'Washington', mascot: 'Huskies', conf: 'Big Ten', color: '#4B2E83' },
  { id: 'wisconsin', name: 'Wisconsin', mascot: 'Badgers', conf: 'Big Ten', color: '#C5050C' },

  // --- ACC ---
  { id: 'boston-college', name: 'Boston College', mascot: 'Eagles', conf: 'ACC', color: '#98002E' },
  { id: 'california', name: 'California', mascot: 'Golden Bears', conf: 'ACC', color: '#003262' },
  { id: 'clemson', name: 'Clemson', mascot: 'Tigers', conf: 'ACC', color: '#F66733' },
  { id: 'duke', name: 'Duke', mascot: 'Blue Devils', conf: 'ACC', color: '#003087' },
  { id: 'florida-state', name: 'Florida State', mascot: 'Seminoles', conf: 'ACC', color: '#782F40' },
  { id: 'georgia-tech', name: 'Georgia Tech', mascot: 'Yellow Jackets', conf: 'ACC', color: '#B3A369' },
  { id: 'louisville', name: 'Louisville', mascot: 'Cardinals', conf: 'ACC', color: '#AD0000' },
  { id: 'miami', name: 'Miami', mascot: 'Hurricanes', conf: 'ACC', color: '#F47321' },
  { id: 'nc-state', name: 'NC State', mascot: 'Wolfpack', conf: 'ACC', color: '#CC0000' },
  { id: 'north-carolina', name: 'North Carolina', mascot: 'Tar Heels', conf: 'ACC', color: '#4B9CD3' },
  { id: 'pittsburgh', name: 'Pittsburgh', mascot: 'Panthers', conf: 'ACC', color: '#003594' },
  { id: 'smu', name: 'SMU', mascot: 'Mustangs', conf: 'ACC', color: '#354CA1' },
  { id: 'stanford', name: 'Stanford', mascot: 'Cardinal', conf: 'ACC', color: '#8C1515' },
  { id: 'syracuse', name: 'Syracuse', mascot: 'Orange', conf: 'ACC', color: '#F76900' },
  { id: 'virginia', name: 'Virginia', mascot: 'Cavaliers', conf: 'ACC', color: '#232D4B' },
  { id: 'virginia-tech', name: 'Virginia Tech', mascot: 'Hokies', conf: 'ACC', color: '#630031' },
  { id: 'wake-forest', name: 'Wake Forest', mascot: 'Demon Deacons', conf: 'ACC', color: '#9E7E38' },

  // --- Big 12 ---
  { id: 'arizona', name: 'Arizona', mascot: 'Wildcats', conf: 'Big 12', color: '#AB0520' },
  { id: 'arizona-state', name: 'Arizona State', mascot: 'Sun Devils', conf: 'Big 12', color: '#8C1D40' },
  { id: 'baylor', name: 'Baylor', mascot: 'Bears', conf: 'Big 12', color: '#154734' },
  { id: 'byu', name: 'BYU', mascot: 'Cougars', conf: 'Big 12', color: '#002E5D' },
  { id: 'cincinnati', name: 'Cincinnati', mascot: 'Bearcats', conf: 'Big 12', color: '#E00122' },
  { id: 'colorado', name: 'Colorado', mascot: 'Buffaloes', conf: 'Big 12', color: '#CFB87C' },
  { id: 'houston', name: 'Houston', mascot: 'Cougars', conf: 'Big 12', color: '#C8102E' },
  { id: 'iowa-state', name: 'Iowa State', mascot: 'Cyclones', conf: 'Big 12', color: '#C8102E' },
  { id: 'kansas', name: 'Kansas', mascot: 'Jayhawks', conf: 'Big 12', color: '#0051BA' },
  { id: 'kansas-state', name: 'Kansas State', mascot: 'Wildcats', conf: 'Big 12', color: '#512888' },
  { id: 'oklahoma-state', name: 'Oklahoma State', mascot: 'Cowboys', conf: 'Big 12', color: '#FF7300' },
  { id: 'tcu', name: 'TCU', mascot: 'Horned Frogs', conf: 'Big 12', color: '#4D1979' },
  { id: 'texas-tech', name: 'Texas Tech', mascot: 'Red Raiders', conf: 'Big 12', color: '#CC0000' },
  { id: 'ucf', name: 'UCF', mascot: 'Knights', conf: 'Big 12', color: '#BA9B37' },
  { id: 'utah', name: 'Utah', mascot: 'Utes', conf: 'Big 12', color: '#CC0000' },
  { id: 'west-virginia', name: 'West Virginia', mascot: 'Mountaineers', conf: 'Big 12', color: '#002855' },

  // --- Independents ---
  { id: 'notre-dame', name: 'Notre Dame', mascot: 'Fighting Irish', conf: 'Independent', color: '#0C2340' },
  { id: 'uconn', name: 'UConn', mascot: 'Huskies', conf: 'Independent', color: '#000E2F' },

  // --- American ---
  { id: 'army', name: 'Army', mascot: 'Black Knights', conf: 'American', color: '#D4BF91' },
  { id: 'charlotte', name: 'Charlotte', mascot: '49ers', conf: 'American', color: '#046A38' },
  { id: 'east-carolina', name: 'East Carolina', mascot: 'Pirates', conf: 'American', color: '#592A8A' },
  { id: 'florida-atlantic', name: 'Florida Atlantic', mascot: 'Owls', conf: 'American', color: '#003366' },
  { id: 'memphis', name: 'Memphis', mascot: 'Tigers', conf: 'American', color: '#003087' },
  { id: 'navy', name: 'Navy', mascot: 'Midshipmen', conf: 'American', color: '#00205B' },
  { id: 'north-texas', name: 'North Texas', mascot: 'Mean Green', conf: 'American', color: '#00853E' },
  { id: 'rice', name: 'Rice', mascot: 'Owls', conf: 'American', color: '#00205B' },
  { id: 'south-florida', name: 'South Florida', mascot: 'Bulls', conf: 'American', color: '#006747' },
  { id: 'temple', name: 'Temple', mascot: 'Owls', conf: 'American', color: '#9D2235' },
  { id: 'tulane', name: 'Tulane', mascot: 'Green Wave', conf: 'American', color: '#006747' },
  { id: 'tulsa', name: 'Tulsa', mascot: 'Golden Hurricane', conf: 'American', color: '#002D72' },
  { id: 'utsa', name: 'UTSA', mascot: 'Roadrunners', conf: 'American', color: '#0C2340' },

  // --- Mountain West ---
  { id: 'air-force', name: 'Air Force', mascot: 'Falcons', conf: 'Mountain West', color: '#003087' },
  { id: 'boise-state', name: 'Boise State', mascot: 'Broncos', conf: 'Mountain West', color: '#0033A0' },
  { id: 'colorado-state', name: 'Colorado State', mascot: 'Rams', conf: 'Mountain West', color: '#1E4D2B' },
  { id: 'fresno-state', name: 'Fresno State', mascot: 'Bulldogs', conf: 'Mountain West', color: '#DB0032' },
  { id: 'hawaii', name: 'Hawaii', mascot: 'Rainbow Warriors', conf: 'Mountain West', color: '#024731' },
  { id: 'nevada', name: 'Nevada', mascot: 'Wolf Pack', conf: 'Mountain West', color: '#003366' },
  { id: 'new-mexico', name: 'New Mexico', mascot: 'Lobos', conf: 'Mountain West', color: '#BA0C2F' },
  { id: 'san-diego-state', name: 'San Diego State', mascot: 'Aztecs', conf: 'Mountain West', color: '#A6192E' },
  { id: 'san-jose-state', name: 'San Jose State', mascot: 'Spartans', conf: 'Mountain West', color: '#0055A2' },
  { id: 'unlv', name: 'UNLV', mascot: 'Rebels', conf: 'Mountain West', color: '#CF0A2C' },
  { id: 'utah-state', name: 'Utah State', mascot: 'Aggies', conf: 'Mountain West', color: '#00263A' },
  { id: 'wyoming', name: 'Wyoming', mascot: 'Cowboys', conf: 'Mountain West', color: '#492F24' },

  // --- Sun Belt ---
  { id: 'appalachian-state', name: 'Appalachian State', mascot: 'Mountaineers', conf: 'Sun Belt', color: '#000000' },
  { id: 'arkansas-state', name: 'Arkansas State', mascot: 'Red Wolves', conf: 'Sun Belt', color: '#CC092F' },
  { id: 'coastal-carolina', name: 'Coastal Carolina', mascot: 'Chanticleers', conf: 'Sun Belt', color: '#006F71' },
  { id: 'georgia-southern', name: 'Georgia Southern', mascot: 'Eagles', conf: 'Sun Belt', color: '#041E42' },
  { id: 'georgia-state', name: 'Georgia State', mascot: 'Panthers', conf: 'Sun Belt', color: '#0039A6' },
  { id: 'james-madison', name: 'James Madison', mascot: 'Dukes', conf: 'Sun Belt', color: '#450084' },
  { id: 'louisiana', name: 'Louisiana', mascot: 'Ragin’ Cajuns', conf: 'Sun Belt', color: '#CE181E' },
  { id: 'louisiana-monroe', name: 'Louisiana-Monroe', mascot: 'Warhawks', conf: 'Sun Belt', color: '#840029' },
  { id: 'marshall', name: 'Marshall', mascot: 'Thundering Herd', conf: 'Sun Belt', color: '#00B140' },
  { id: 'old-dominion', name: 'Old Dominion', mascot: 'Monarchs', conf: 'Sun Belt', color: '#003057' },
  { id: 'south-alabama', name: 'South Alabama', mascot: 'Jaguars', conf: 'Sun Belt', color: '#00205B' },
  { id: 'southern-miss', name: 'Southern Miss', mascot: 'Golden Eagles', conf: 'Sun Belt', color: '#000000' },
  { id: 'texas-state', name: 'Texas State', mascot: 'Bobcats', conf: 'Sun Belt', color: '#501214' },
  { id: 'troy', name: 'Troy', mascot: 'Trojans', conf: 'Sun Belt', color: '#8A2432' },

  // --- MAC ---
  { id: 'akron', name: 'Akron', mascot: 'Zips', conf: 'MAC', color: '#041E42' },
  { id: 'ball-state', name: 'Ball State', mascot: 'Cardinals', conf: 'MAC', color: '#BA0C2F' },
  { id: 'bowling-green', name: 'Bowling Green', mascot: 'Falcons', conf: 'MAC', color: '#4F2C1D' },
  { id: 'buffalo', name: 'Buffalo', mascot: 'Bulls', conf: 'MAC', color: '#005BBB' },
  { id: 'central-michigan', name: 'Central Michigan', mascot: 'Chippewas', conf: 'MAC', color: '#6A0032' },
  { id: 'eastern-michigan', name: 'Eastern Michigan', mascot: 'Eagles', conf: 'MAC', color: '#046A38' },
  { id: 'kent-state', name: 'Kent State', mascot: 'Golden Flashes', conf: 'MAC', color: '#002664' },
  { id: 'miami-oh', name: 'Miami (OH)', mascot: 'RedHawks', conf: 'MAC', color: '#C41230' },
  { id: 'northern-illinois', name: 'Northern Illinois', mascot: 'Huskies', conf: 'MAC', color: '#BA0C2F' },
  { id: 'ohio', name: 'Ohio', mascot: 'Bobcats', conf: 'MAC', color: '#00694E' },
  { id: 'toledo', name: 'Toledo', mascot: 'Rockets', conf: 'MAC', color: '#15397F' },
  { id: 'western-michigan', name: 'Western Michigan', mascot: 'Broncos', conf: 'MAC', color: '#6C4023' },

  // --- Conference USA ---
  { id: 'fiu', name: 'FIU', mascot: 'Panthers', conf: 'C-USA', color: '#081E3F' },
  { id: 'jacksonville-state', name: 'Jacksonville State', mascot: 'Gamecocks', conf: 'C-USA', color: '#BA0C2F' },
  { id: 'kennesaw-state', name: 'Kennesaw State', mascot: 'Owls', conf: 'C-USA', color: '#FDBB30' },
  { id: 'liberty', name: 'Liberty', mascot: 'Flames', conf: 'C-USA', color: '#0A254E' },
  { id: 'louisiana-tech', name: 'Louisiana Tech', mascot: 'Bulldogs', conf: 'C-USA', color: '#002F8B' },
  { id: 'middle-tennessee', name: 'Middle Tennessee', mascot: 'Blue Raiders', conf: 'C-USA', color: '#0066CC' },
  { id: 'new-mexico-state', name: 'New Mexico State', mascot: 'Aggies', conf: 'C-USA', color: '#8C0B42' },
  { id: 'sam-houston', name: 'Sam Houston', mascot: 'Bearkats', conf: 'C-USA', color: '#F56600' },
  { id: 'utep', name: 'UTEP', mascot: 'Miners', conf: 'C-USA', color: '#041E42' },
  { id: 'western-kentucky', name: 'Western Kentucky', mascot: 'Hilltoppers', conf: 'C-USA', color: '#B01E24' },

  // --- Pac-12 ---
  { id: 'oregon-state', name: 'Oregon State', mascot: 'Beavers', conf: 'Pac-12', color: '#DC4405' },
  { id: 'washington-state', name: 'Washington State', mascot: 'Cougars', conf: 'Pac-12', color: '#981E32' },
];

const BY_ID = new Map(TEAMS.map((t) => [t.id, t]));

/** The default, and the one team that already has a researched document. */
const DEFAULT_TEAM = 'uga';

function get(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

/** A team id, or null. Used wherever an id arrives from a request: an unknown
 *  one must not become a Firestore document key, or a typo in a URL creates a
 *  `fan/<junk>` row that nothing will ever clean up. */
function validId(id) {
  return get(id) ? get(id).id : null;
}

/** The picker's payload. Grouped by conference because a flat list of 130
 *  names is not something anyone can find their team in. */
function list() {
  const byConf = new Map();
  for (const t of TEAMS) {
    if (!byConf.has(t.conf)) byConf.set(t.conf, []);
    byConf.get(t.conf).push({ id: t.id, name: t.name, mascot: t.mascot, color: t.color });
  }
  return [...byConf.entries()].map(([conf, teams]) => ({ conf, teams }));
}

module.exports = { TEAMS, DEFAULT_TEAM, get, validId, list };
