/**
 * Lead-scoring configuration. Everything tunable lives here so the rules can be
 * adjusted without touching engine logic. Later phases can load overrides from
 * the `settings` table and merge them on top of this object.
 */

module.exports = {
  modelVersion: 'v1',
  maxScore: 100,

  // How recent counts as "recently registered".
  recentlyRegisteredDays: 180,

  // Target markets — case-insensitive substring match against company.industry / state.
  targetIndustries: [
    'IT',
    'Information Technology',
    'Software',
    'Healthcare',
    'Education',
    'Restaurant',
    'Food & Beverage',
    'Hospitality',
    'Real Estate',
    'Consulting',
    'Retail',
    'E-commerce',
  ],
  targetLocations: [
    'Maharashtra',
    'Karnataka',
    'Delhi',
    'Telangana',
    'Tamil Nadu',
    'Gujarat',
    'Haryana',
  ],

  // Rule weights. `key` is referenced in the score breakdown.
  rules: {
    recentlyRegistered: { points: 20, label: 'Recently registered' },
    targetIndustry: { points: 15, label: 'In a target industry' },
    targetLocation: { points: 10, label: 'In a target location' },
    noWebsite: { points: 25, label: 'No website found' },
    poorWebsite: { points: 15, label: 'Poor / outdated website' },
    publicBusinessEmail: { points: 5, label: 'Public business email available' },
    businessPhone: { points: 5, label: 'Business phone available' },
    socialPresence: { points: 5, label: 'Has social presence' },
  },

  // score >= threshold  ->  temperature
  temperatureBands: [
    { min: 90, temperature: 'HOT' },
    { min: 75, temperature: 'HIGH' },
    { min: 50, temperature: 'WARM' },
    { min: 30, temperature: 'LOW' },
    { min: 0, temperature: 'NOT_QUALIFIED' },
  ],

  opportunityLevels: [
    { min: 85, level: 'Excellent' },
    { min: 65, level: 'Strong' },
    { min: 45, level: 'Moderate' },
    { min: 0, level: 'Low' },
  ],
};
