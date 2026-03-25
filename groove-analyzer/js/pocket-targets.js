// ============================================
// pocket-targets.js — Named pocket target definitions
// ============================================

const PocketTargets = (() => {

  const TARGETS = [
    {
      id: 'driving-rock',
      name: 'Driving Rock',
      description: 'Slightly ahead. Urgency without rushing.',
      positionMin: -15,
      positionMax: -5,
      genre: 'Rock',
      tempoRange: [110, 140],
      defaultTempo: 120,
      difficulty: 'beginner',
      reference: "Think AC/DC's Phil Rudd, the Ramones.",
      artists: ['Phil Rudd', 'Tommy Ramone']
    },
    {
      id: 'on-the-one',
      name: 'On the One',
      description: 'Right on top of beat 1 with forward momentum.',
      positionMin: -10,
      positionMax: 2,
      genre: 'Funk',
      tempoRange: [105, 130],
      defaultTempo: 115,
      difficulty: 'intermediate',
      reference: "James Brown's band. The one is everything.",
      artists: ['James Brown', 'Clyde Stubblefield']
    },
    {
      id: 'center',
      name: 'Straight Down the Middle',
      description: 'Dead center, tight. Right on the grid.',
      positionMin: -5,
      positionMax: 5,
      genre: 'Universal',
      tempoRange: [80, 120],
      defaultTempo: 100,
      difficulty: 'beginner',
      reference: 'The baseline. Harder than it sounds.',
      artists: ['Steve Gadd']
    },
    {
      id: 'motown',
      name: 'Motown Pocket',
      description: 'Just barely behind. Warm, not obviously late.',
      positionMin: 3,
      positionMax: 10,
      genre: 'Soul / R&B',
      tempoRange: [95, 125],
      defaultTempo: 108,
      difficulty: 'intermediate',
      reference: "The Funk Brothers' signature feel.",
      artists: ['Benny Benjamin', 'Pistol Allen']
    },
    {
      id: 'pino',
      name: 'The Pino',
      description: 'Behind the beat, extremely tight. Surgical precision.',
      positionMin: 8,
      positionMax: 18,
      genre: 'Neo-Soul / Pop',
      tempoRange: [70, 100],
      defaultTempo: 85,
      difficulty: 'intermediate-advanced',
      reference: "Pino Palladino with D'Angelo, John Mayer.",
      artists: ['Pino Palladino']
    },
    {
      id: 'greasy-funk',
      name: 'Greasy Funk',
      description: "Behind the beat, moderate width. Sways but doesn't wander.",
      positionMin: 10,
      positionMax: 22,
      genre: 'Funk',
      tempoRange: [90, 115],
      defaultTempo: 100,
      difficulty: 'intermediate',
      reference: "The Meters, Herbie Hancock's Headhunters.",
      artists: ['Zigaboo Modeliste', 'Harvey Mason']
    },
    {
      id: 'boom-bap',
      name: 'Boom-Bap',
      description: 'Behind with subtle swing. Classic hip-hop humanity.',
      positionMin: 10,
      positionMax: 20,
      genre: 'Hip-Hop',
      tempoRange: [85, 100],
      defaultTempo: 92,
      difficulty: 'intermediate',
      reference: 'DJ Premier, Pete Rock. The human micro-timing that separates real from programmed.',
      artists: ['DJ Premier', 'Pete Rock', 'J Dilla']
    },
    {
      id: 'questlove',
      name: 'The Questlove',
      description: 'Deep behind the beat. Relaxed, heavy, gravitational.',
      positionMin: 15,
      positionMax: 28,
      genre: 'Neo-Soul',
      tempoRange: [75, 95],
      defaultTempo: 88,
      difficulty: 'intermediate',
      reference: "The Voodoo-era pocket. The snare arrives late and doesn't care.",
      artists: ['Questlove', "D'Angelo"]
    }
  ];

  function getAll() { return TARGETS; }

  function getById(id) { return TARGETS.find(t => t.id === id); }

  function getDifficultyDots(difficulty) {
    switch (difficulty) {
      case 'beginner': return 1;
      case 'intermediate': return 2;
      case 'intermediate-advanced': return 3;
      case 'advanced': return 3;
      default: return 1;
    }
  }

  return {
    getAll,
    getById,
    getDifficultyDots
  };
})();
