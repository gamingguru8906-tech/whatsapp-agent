// Watch book rule id -> the watch details it needs (keys and values from data/watch-attributes.json).
// approve: true makes a rule the reader marked MAYBE usable because the owner decided it (dial colours: "Kove wins").
// A rule id that is not here is not computable from the form and waits for the owner.
const w = (attr, ...vals) => ({ watch: { [attr]: vals } });
const all = (...xs) => ({ all: xs });

export const WATCH_MAP = {
  // Dial colour: owner decision 9 (the watch book's colour meanings win). Background/method rows are not shown.
  'COL-1': { when: w('dialColour', 'red'), approve: true }, 'COL-2': { when: w('dialColour', 'orange'), approve: true },
  'COL-3': { when: w('dialColour', 'yellow'), approve: true }, 'COL-4': { when: w('dialColour', 'green'), approve: true },
  'COL-5': { when: w('dialColour', 'blue'), approve: true }, 'COL-6': { when: w('dialColour', 'indigo'), approve: true },
  'COL-7': { when: w('dialColour', 'violet'), approve: true }, 'COL-8': { when: w('dialColour', 'black'), approve: true },
  'COL-9': { when: w('dialColour', 'white'), approve: true }, 'COL-10': { when: w('dialColour', 'grey'), approve: true },
  'COL-11': { when: w('dialColour', 'pink'), approve: true }, 'COL-12': { when: w('dialColour', 'gold'), approve: true },
  'COL-13': { when: w('dialColour', 'roseGold'), approve: true }, 'COL-14': { when: w('dialColour', 'silver'), approve: true },
  'COL-15': { when: w('dialColour', 'maroon'), approve: true }, 'COL-16': { when: w('dialColour', 'brown'), approve: true },
  // Wrist
  'WR-1': { when: w('wrist', 'right') }, 'WR-2': { when: w('wrist', 'left') }, 'WR-3': { when: w('wrist', 'both') },
  'WR-4': { when: w('goal', 'men'), kind: 'therapy' }, 'WR-5': { when: w('goal', 'women'), kind: 'therapy' },
  'WR-6': { when: w('goal', 'men', 'women'), kind: 'therapy' },
  // Dial size
  'DS-1': { when: w('dialSize', 'small') }, 'DS-2': { when: w('dialSize', 'medium') }, 'DS-4': { when: w('dialSize', 'large') },
  'DS-7': { when: w('dialSize', 'extraLarge') }, 'DS-5': { when: w('goal', 'confidence'), kind: 'therapy' },
  // Dial shape
  'SH-1': { when: w('dialShape', 'round') }, 'SH-2': { when: w('dialShape', 'round') },
  'SH-3': { when: w('dialShape', 'square') }, 'SH-4': { when: w('dialShape', 'square') }, 'SH-5': { when: w('dialShape', 'square') },
  'SH-6': { when: w('dialShape', 'rectVertical') }, 'SH-7': { when: w('dialShape', 'rectHorizontal') },
  'SH-8': { when: w('dialShape', 'roundedRect') }, 'SH-10': { when: w('dialShape', 'ovalVertical') },
  'SH-11': { when: w('dialShape', 'ovalHorizontal') },
  'SH-12': { when: w('dialShape', 'hexHorizontal', 'hexVertical') }, 'SH-13': { when: w('dialShape', 'hexHorizontal') },
  'SH-14': { when: w('dialShape', 'hexVertical') }, 'SH-15': { when: w('dialShape', 'hexHorizontal', 'hexVertical') },
  'SH-16': { when: w('dialShape', 'octagon') },
  // Numeral size and style
  'DG-1': { when: w('numeralSize', 'large') }, 'DG-2': { when: w('numeralSize', 'medium') },
  'DG-3': { when: w('numeralSize', 'small') }, 'DG-4': { when: w('numeralSize', 'extraLarge') },
  'DG-5': { when: w('markers', 'roman') }, 'DG-7': { when: w('markers', 'arabic') }, 'DG-8': { when: w('markers', 'regional') },
  'DG-9': { when: w('markers', 'none', 'dots', 'dashes') }, 'DG-10': { when: w('markers', 'dashes') },
  'DG-11': { when: w('markers', 'dots') }, 'DG-12': { when: w('markers', 'stars') },
  'DG-13': { when: w('markers', 'diamonds') }, 'DG-14': { when: w('markers', 'diamonds') },
  'DG-15': { when: w('dialArt', 'glitter') }, 'DG-6': { when: w('goal', 'marketing'), kind: 'therapy' },
  // Which numerals are shown
  'NUM-1': { when: w('numeralsShown', 'quarters') }, 'NUM-2': { when: w('numeralsShown', 'onlyTwelve') },
  'NUM-3': { when: w('numeralsShown', 'quarters', 'onlyTwelve') }, 'NUM-6': { when: w('numeralsShown', 'quarters') },
  'NUM-12': { when: w('numeralsShown', 'even') }, 'NUM-13': { when: w('numeralsShown', 'odd') },
  'NUM-14': { when: all(w('markers', 'none'), w('numeralsShown', 'noneShown')) },
  // Date and day window and where it sits
  'DT-1': { when: w('dateWindow', 'dayDate') }, 'DT-2': { when: w('dateWindow', 'day') }, 'DT-3': { when: w('dateWindow', 'dayDate') },
  'DT-5': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '12')) },
  'DT-6': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '1')) },
  'DT-7': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '2')) },
  'DT-8': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '3')) },
  'DT-9': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '4')) },
  'DT-10': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '5')) },
  'DT-11': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '6')) },
  'DT-12': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '7')) },
  'DT-13': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '8')) },
  'DT-14': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '9')) },
  'DT-15': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '10')) },
  'DT-16': { when: all(w('dateWindow', 'date', 'day', 'dayDate'), w('datePosition', '11')) },
  // Strap
  'BS-1': { when: w('strapWidth', 'wide') }, 'BS-2': { when: w('strapWidth', 'medium') }, 'BS-3': { when: w('strapWidth', 'narrow') },
  'BM-1': { when: w('strapMaterial', 'metal') }, 'BM-3': { when: w('strapMaterial', 'leather') },
  'BM-4': { when: all(w('goal', 'warmth'), w('strapMaterial', 'metal')), kind: 'therapy' },
  'BM-5': { when: w('strapMaterial', 'rubber') }, 'BM-6': { when: w('strapMaterial', 'wood') },
  'BM-7': { when: w('strapMaterial', 'stone') }, 'BM-8': { when: w('strapMaterial', 'crystal') },
  'BM-9': { when: w('strapMaterial', 'velcro') }, 'BM-10': { when: w('strapMaterial', 'resin') },
  'BM-11': { when: w('strapMaterial', 'nylon') }, 'BM-12': { when: w('strapMaterial', 'silicone') },
  'BM-13': { when: w('strapMaterial', 'fabric') },
  'BX-1': { when: w('strapStructure', 'longLinks') }, 'BX-2': { when: w('strapStructure', 'gaps') },
  // Hands
  'HD-3': { when: w('hands', 'noSeconds') }, 'HD-4': { when: w('hands', 'noMinute') },
  'HD-6': { when: w('handStyle', 'odd') }, 'HD-7': { when: w('handStyle', 'sharp') }, 'HD-8': { when: w('handStyle', 'tails') },
  // Thickness, type, originality
  'TH-1': { when: w('thickness', 'thin') }, 'TH-2': { when: w('thickness', 'thick') },
  'MP-1': { when: w('watchType', 'smart', 'sports') }, 'MP-2': { when: w('watchType', 'smart', 'sports') },
  'FC-1': { when: w('original', 'firstCopy') }, 'FC-3': { when: w('original', 'original') },
  // Gifts
  'GF-1': { when: w('gift', 'worn', 'kept') }, 'GF-5': { when: w('gift', 'kept') },
  // Dial pictures and patterns
  'DV-1': { when: w('dialArt', 'text') }, 'DV-2': { when: w('dialArt', 'face') }, 'DV-4': { when: w('dialArt', 'scenery') },
  'DV-5': { when: w('dialArt', 'animal') }, 'DV-6': { when: w('dialArt', 'birds') }, 'DV-7': { when: w('dialArt', 'plants') },
  'DV-8': { when: w('dialArt', 'verticalLines') }, 'DV-9': { when: w('dialArt', 'horizontalLines') },
  'DV-10': { when: w('dialArt', 'spiral') }, 'DV-11': { when: w('dialArt', 'circles') },
  'OT-2': { when: w('watchType', 'pocketFlip') }, 'OT-3': { when: w('watchType', 'reversible') }, 'OT-5': { when: w('dialArt', 'compass') },
  // Power, number of watches, how worn
  'CH-1': { when: w('power', 'solar') }, 'CH-2': { when: w('power', 'automatic') }, 'CH-3': { when: w('power', 'battery') },
  'CH-4': { when: w('power', 'manual') }, 'CH-5': { when: w('power', 'charging') },
  'MW-1': { when: w('watchCount', 'several') }, 'MW-2': { when: w('watchCount', 'several') },
  'WW-1': { when: w('howWorn', 'inside') }, 'WW-2': { when: w('howWorn', 'outside') }
};
