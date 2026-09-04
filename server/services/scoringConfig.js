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

  // Target markets — case-insensitive substring match against company.industry / state / city.
  // Includes both formal sector names (CSV/Apollo data) and the plain search terms a user
  // types into Automatic Lead Gen (e.g. "Hotels", "Clinics") — those aren't substrings of
  // each other, so both forms need to be listed.
  targetIndustries: [
    'IT',
    'Information Technology',
    'Software',
    'Healthcare',
    'Clinic',
    'Hospital',
    'Doctor',
    'Education',
    'School',
    'College',
    'Restaurant',
    'Cafe',
    'Food & Beverage',
    'Hospitality',
    'Hotel',
    'Resort',
    'Travel',
    'Real Estate',
    'Realty',
    'Property',
    'Consulting',
    'Retail',
    'Shop',
    'E-commerce',
    'Law Firm',
    'Legal',
    'Lawyer',
    'Manufactur',
    'Startup',
  ],
  // Matched against both company.state and company.city — so international targets
  // (Dubai, London, USA) work the same way as Indian states/cities do.
  targetLocations: [
    'Maharashtra',
    'Karnataka',
    'Delhi',
    'Telangana',
    'Tamil Nadu',
    'Gujarat',
    'Ahmedabad',
    'Mumbai',
    'Bengaluru',
    'Bangalore',
    'Dubai',
    'UAE',
    'London',
    'United Kingdom',
    'USA',
    'United States',
    'Haryana',
  ],

  // Rule weights. `key` is referenced in the score breakdown.
  rules: {
    activeBuyingSignal: { points: 35, label: 'Active buying signal (asked for a service)' },
    recentlyRegistered: { points: 20, label: 'Recently registered' },
    targetIndustry: { points: 15, label: 'In a target industry' },
    targetLocation: { points: 10, label: 'In a target location' },
    noWebsite: { points: 25, label: 'No website found' },
    poorWebsite: { points: 15, label: 'Poor / outdated website' },
    publicBusinessEmail: { points: 5, label: 'Public business email available' },
    businessPhone: { points: 5, label: 'Business phone available' },
    socialPresence: { points: 5, label: 'Has social presence' },
  },

  // A signal is "active" (still worth acting on) while in one of these statuses.
  activeSignalStatuses: ['NEW', 'REVIEWED'],

  // Map a Signal.service enum onto the recommended-service label shown in the CRM.
  signalServiceLabels: {
    WEBSITE_DEVELOPMENT: 'Website Development',
    WEBSITE_REDESIGN: 'Website Redesign',
    SOFTWARE_DEVELOPMENT: 'Custom Software Development',
    MOBILE_APP: 'Mobile App Development',
    CRM: 'CRM Implementation',
    ECOMMERCE: 'E-commerce Store Setup',
    DIGITAL_MARKETING: 'Digital Growth / SEO & Marketing',
    OTHER: null,
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
