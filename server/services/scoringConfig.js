/**
 * Rule-based lead-scoring configuration. This is NOT an LLM call — every
 * number here is a plain, auditable weight. Everything tunable lives in this
 * file so the rubric can change without touching engine logic.
 *
 * Score = sum of 6 categories, each capped at its own max, total capped at 100:
 *   Website Opportunity   0-20
 *   Software Opportunity  0-20
 *   Business Growth       0-15
 *   Buying Signal         0-20
 *   Contactability        0-10
 *   Codefloor Fit         0-15
 */

module.exports = {
  modelVersion: 'rule-based-v2',
  maxScore: 100,

  categoryMax: {
    websiteOpportunity: 20,
    softwareOpportunity: 20,
    businessGrowth: 15,
    buyingSignal: 20,
    contactability: 10,
    codefloorFit: 15,
  },

  // --- Website Opportunity: scored from the live website audit health rating ---
  websiteOpportunityByHealth: {
    no_website: 20,
    outdated: 16,
    poor: 12,
    fair: 6,
    good: 2,
    excellent: 0,
    unknown: 10, // not audited yet — neutral, not zero
  },

  // --- Software Opportunity: scaled by how many distinct non-website opportunities were detected ---
  softwareOpportunityByCount: [
    { min: 3, points: 20 },
    { min: 2, points: 15 },
    { min: 1, points: 10 },
    { min: 0, points: 0 },
  ],

  // --- Business Growth: how "new" this business is to the market or to us ---
  recentlyRegisteredDays: 180,
  businessGrowthPoints: {
    recentlyRegistered: 15, // real incorporation date within recentlyRegisteredDays
    newlyDiscovered: 6, // first time our discovery has ever seen this business
    none: 0,
  },

  // --- Buying Signal: explicit intent beats inferred signals ---
  buyingSignalPoints: {
    activeIntentSignal: 20, // someone explicitly asked for a service (the `signals` table)
    detectedSignalStrength: { HIGH: 15, MEDIUM: 10, LOW: 5, NONE: 0 }, // auto-detected (see signalDetectionService)
  },
  activeSignalStatuses: ['NEW', 'REVIEWED'],

  // --- Contactability: reuses contactabilityService's 0-10 score directly ---

  // --- Codefloor Fit: target industry + target location match ---
  codefloorFitPoints: { industry: 8, location: 7 },
  // Both formal sector names (CSV/Apollo data) and plain search terms typed into
  // Automatic Lead Gen ("Hotels", "Clinics") — matched as case-insensitive substrings.
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
  // Matched against both company.state and company.city.
  targetLocations: [
    'Maharashtra',
    'Karnataka',
    'Delhi',
    'Telangana',
    'Tamil Nadu',
    'Gujarat',
    'Haryana',
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
  ],

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
