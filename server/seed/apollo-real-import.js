/**
 * One-off import of real companies pulled from Apollo.io (free organization
 * lookup + paid-per-record enrichment) during a live Claude Code session with
 * the user's Apollo MCP connection. This is NOT a repeatable script — the data
 * is hardcoded from that session's real API responses so the CRM has genuine
 * companies with genuine HQ phone numbers instead of only demo data.
 *
 * Run once: node seed/apollo-real-import.js
 */
require('dotenv').config();
const config = require('../config/config');
const { sequelize, User } = require('../models');
const { upsertCompany } = require('../services/apolloService');

// Normalized shape matches ApolloCompanyProvider.normalizeCompany() output.
const COMPANIES = [
  { company_name: 'EG Allied Pvt. Ltd.', website: 'https://egallied.com', phone: '+91 85499 93573', industry: 'Information Technology & Services', city: 'Jaipur', state: 'Rajasthan', registered_address: '30/41/01, Varun Path Mansarovar, Jaipur, Rajasthan, India, 302020', apollo_organization_id: '5fc8788ee021610001922043', linkedin_url: 'https://www.linkedin.com/company/egallied', employee_count: 48, founded_year: 2020 },
  { company_name: 'Idea Usher', website: 'https://ideausher.com', phone: '+91 89300 90960', industry: 'Information Technology & Services', city: 'Sahibzada Ajit Singh Nagar', state: 'Punjab', registered_address: 'Sebiz Square, SCF-98, 2nd floor, Phase 11, Mohali, Punjab 160062, India', apollo_organization_id: '556d3cf273696412843cbc00', linkedin_url: 'https://www.linkedin.com/company/idea-usher', employee_count: 140, annual_revenue: 5768000, founded_year: 2013 },
  { company_name: 'Kalpita Technologies', website: 'https://kalpitatechnologies.com', phone: '+91 87620 33990', industry: 'Information Technology & Services', city: 'Bengaluru', state: 'Karnataka', registered_address: '4M, 417/A, HRBR Layout 3rd Block, Kammanahalli Main Road, Bangalore, Karnataka 560043, India', apollo_organization_id: '5da328b6db06ce0001fb925a', linkedin_url: 'https://www.linkedin.com/company/kalpitatechnologies', employee_count: 140, annual_revenue: 3000000, founded_year: 2018 },
  { company_name: 'TerraGiG', website: 'https://terragig.in', phone: '+91 81487 24828', industry: 'Information Technology & Staffing', city: 'Chennai', state: 'Tamil Nadu', registered_address: 'Perumbakkam Main Road, Cheran Nagar, Chennai, Tamil Nadu 600100, India', apollo_organization_id: '639c0068456ac100a33925f2', linkedin_url: 'https://www.linkedin.com/company/terragig-consulting', employee_count: 24, founded_year: 2022 },
  { company_name: 'Delphic Global', website: 'https://delphic.in', phone: '+91 79007 39027', industry: 'Information Technology & Services', city: 'Gurugram', state: 'Haryana', registered_address: 'Gurugram, Haryana, India', apollo_organization_id: '612bacd62b6e6a000174adc1', linkedin_url: 'https://www.linkedin.com/company/delphicservices', employee_count: 88, founded_year: 2018 },
  { company_name: 'Rekruton Technologies', website: 'https://rekruton.in', industry: 'Information Technology & Staffing', city: 'Ahmedabad', state: 'Gujarat', registered_address: 'Ahmedabad, Gujarat 380015, India', apollo_organization_id: '5e5830934ab14d000199d7d2', linkedin_url: 'https://www.linkedin.com/company/rekruton', employee_count: 5 },

  { company_name: 'Spectra Hospitality Services', website: 'https://spectrahospitality.com', industry: 'Hospitality Consulting', city: 'Gurugram', state: 'Haryana', registered_address: '11, Ground Floor, Augusta Point, Sector 53, DLF Golf Course Road, Gurugram, Haryana 122002, India', apollo_organization_id: '54a1359a69702d3170030401', linkedin_url: 'https://www.linkedin.com/company/spectrahospitality', employee_count: 31, founded_year: 2006 },
  { company_name: 'Eclat Hospitality', website: 'https://eclathospitality.com', phone: '+91 98720 00604', industry: 'Hospitality Consulting', city: 'Chandigarh', state: 'Chandigarh', registered_address: 'SCO 12-13, Second Floor, Bansawali Chungi, NH 21, Kharar - New Mohali, Chandigarh, India', apollo_organization_id: '54a12a2d69702d8b193d7a02', linkedin_url: 'https://www.linkedin.com/company/eclathospitality', employee_count: 21, annual_revenue: 877000, founded_year: 2005 },
  { company_name: 'BSG Hospitality', website: 'https://bsghospitality.com', phone: '+91 91760 20000', industry: 'Hospitality', city: 'Panjim', state: 'Goa', registered_address: '91Springboard Business Hub, 18th June Road, Panaji, Goa 403001, India', apollo_organization_id: '5fcad02569ec3000015ed6f3', linkedin_url: 'https://www.linkedin.com/company/bsghospitality', employee_count: 8, annual_revenue: 20000, founded_year: 2020 },

  { company_name: 'Adiuvo Diagnostics Pvt. Ltd.', website: 'https://adiuvodiagnostics.com', phone: '+91 80153 16313', industry: 'Medical Devices', city: 'Chennai', state: 'Tamil Nadu', registered_address: 'Unit 18 Golden Jubilee Biopark for Women, SIPCOT Siruseri IT Park, Chennai, Tamil Nadu 603103, India', apollo_organization_id: '5dce713f877e2c00f2a0557c', linkedin_url: 'https://www.linkedin.com/company/adiuvodiagnostics', employee_count: 30, founded_year: 2015 },
  { company_name: 'Premas Life Sciences Pvt Ltd.', website: 'https://premaslifesciences.com', industry: 'Life Sciences / Research', city: 'New Delhi', state: 'Delhi', registered_address: 'E-49/5, Second Floor, Okhla Phase II, New Delhi, Delhi 110020, India', apollo_organization_id: '57c4bb2ba6da983717eef47e', linkedin_url: 'https://www.linkedin.com/company/premas-lifesciences', employee_count: 140, annual_revenue: 38000000 },
  { company_name: 'Vanguard Diagnostics', website: 'https://vanguarddiagnostics.com', phone: '+91 98995 29499', industry: 'Medical Devices', city: 'New Delhi', state: 'Delhi', registered_address: 'C-123, Okhla Industrial Area, Phase-I, New Delhi, Delhi 110020, India', apollo_organization_id: '5f47f94cac843d0001869bdf', linkedin_url: 'https://www.linkedin.com/company/vanguard-diagnostics', employee_count: 20, founded_year: 2015 },
  { company_name: 'SFRI India (Medical Diagnostics)', website: 'https://sfri.in', industry: 'Medical Devices', city: 'New Delhi', state: 'Delhi', registered_address: 'Okhla Industrial Area 1, DLF Prime Towers, Pocket F, New Delhi, Delhi 110022, India', apollo_organization_id: '66f8d8275e4cdc0001d4f180', linkedin_url: 'https://www.linkedin.com/company/sfriindia', employee_count: 29, founded_year: 2024 },
  { company_name: 'PV Diagnostics', website: 'https://pv-diagnostics.com', phone: '+91 84509 44330', industry: 'Renewables & Environment', city: 'New Delhi', state: 'Delhi', registered_address: 'Westend Marg, New Delhi, Delhi, India', apollo_organization_id: '5b867db9f874f75902082e3f', linkedin_url: 'https://www.linkedin.com/company/pv-diagnostics', employee_count: 13, founded_year: 2017 },

  { company_name: 'Narang Realty', website: 'https://narangrealty.com', phone: '+91 22678 90202', industry: 'Real Estate', city: 'Mumbai', state: 'Maharashtra', registered_address: 'C S T Road, Narang Realty, Mumbai, Maharashtra 400098, India', apollo_organization_id: '5a9f6fc8a6da98d97e837268', linkedin_url: 'https://www.linkedin.com/company/narang-realty', employee_count: 180, founded_year: 1988 },
  { company_name: 'Inspira Realty', website: 'https://inspirarealty.in', phone: '+91 22 6773 3550', industry: 'Real Estate', city: 'Mumbai', state: 'Maharashtra', registered_address: 'Gala Impecca, Andheri - Kurla Rd, Vijay Nagar Colony, J B Nagar, Andheri East, Mumbai 400059, India', apollo_organization_id: '63bc00fad0ab1000f99be4d5', linkedin_url: 'https://www.linkedin.com/company/inspirarealty', employee_count: 94 },
  { company_name: 'PropAdvisor Realty (P) Ltd.', website: 'https://propadvisor.in', industry: 'Real Estate', city: 'Ahmedabad', state: 'Gujarat', registered_address: 'A-207, Thaltej Cross Roads, Ahmedabad, Gujarat 380054, India', apollo_organization_id: '5c1ec890f651253e77d17eda', linkedin_url: 'https://www.linkedin.com/company/propdvisorrealty', employee_count: 6, founded_year: 2017 },
  { company_name: 'Raveshia Realty', website: 'https://raveshiarealty.com', industry: 'Real Estate', city: 'Mumbai', state: 'Maharashtra', registered_address: 'Linking Road, Everest Classic, Mumbai, Maharashtra, India', apollo_organization_id: '5f9bf544e880aa00dcf46dd5', linkedin_url: 'https://www.linkedin.com/company/raveshiarealty', employee_count: 29 },
  { company_name: 'UK Realty', website: 'https://ukrealty.in', phone: '+91 80504 64555', industry: 'Real Estate', city: 'Mumbai', state: 'Maharashtra', registered_address: '8, Abhishek Building, Dalia Ind. Estate, Off New Andheri Link Rd, Andheri West, Mumbai, Maharashtra 400053, India', apollo_organization_id: '5b870bf0f874f726b451d65c', linkedin_url: 'https://www.linkedin.com/company/unique-keemaya', employee_count: 180, founded_year: 2008 },
  { company_name: 'BAJAJ Real Estate', website: 'https://bajajrealestate.com', industry: 'Real Estate', city: 'Raipur', state: 'Chhattisgarh', registered_address: 'VIP Road, 6011, Currency Tower, Raipur, Chhattisgarh 492001, India', apollo_organization_id: '5da60e9446467d0001a9fa6d', linkedin_url: 'https://www.linkedin.com/company/bajajrealestate', employee_count: 30, founded_year: 2014 },
];

async function run() {
  await sequelize.authenticate();
  const admin = await User.findOne({ where: { email: config.admin.email.toLowerCase() } });
  let created = 0;
  let updated = 0;
  let withPhone = 0;

  for (const raw of COMPANIES) {
    const item = { ...raw, date_of_incorporation: raw.founded_year ? `${raw.founded_year}-01-01` : null };
    // eslint-disable-next-line no-await-in-loop
    const { company, created: wasCreated } = await upsertCompany(item, { userId: admin?.id });
    if (wasCreated) created += 1;
    else updated += 1;
    if (item.phone) withPhone += 1;
    console.log(`  ${wasCreated ? '+' : '~'} ${company.company_name} (${company.city}, ${company.state}) score=${company.lead_score} phone=${item.phone || '—'}`);
  }

  console.log(`\n[apollo-import] done. created=${created} updated=${updated} withPhone=${withPhone}/${COMPANIES.length}`);
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[apollo-import] failed:', err);
  process.exit(1);
});
