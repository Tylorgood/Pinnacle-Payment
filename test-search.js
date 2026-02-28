require('dotenv').config();
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testSearch() {
  console.log('Testing Search Integration...\n');
  
  // Test 1: Register a test user
  const testEmail = `test_${Date.now()}@example.com`;
  console.log('1. Registering test user...');
  
  try {
    const registerRes = await axios.post(`${API_URL}/api/auth/register`, {
      email: testEmail,
      password: 'testpass123'
    });
    console.log('   ✓ User registered');
    const token = registerRes.data.token;
    
    // Test 2: Check search credits
    console.log('2. Checking search credits...');
    const creditsRes = await axios.get(`${API_URL}/api/search/credits`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`   ✓ Credits: ${creditsRes.data.remaining} remaining`);
    
    // Test 3: Run a search
    console.log('3. Running web search...');
    const searchRes = await axios.post(`${API_URL}/api/search`, {
      query: 'latest AI news 2025'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`   ✓ Found ${searchRes.data.results.length} results`);
    console.log(`   ✓ First result: ${searchRes.data.results[0]?.title}`);
    console.log(`   ✓ Credits remaining: ${searchRes.data.credits.remaining}`);
    
    // Test 4: Check search history
    console.log('4. Checking search history...');
    const historyRes = await axios.get(`${API_URL}/api/search/history`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`   ✓ History entries: ${historyRes.data.length}`);
    
    console.log('\n✅ All tests passed!');
    
  } catch (error) {
    console.error('   ✗ Error:', error.response?.data || error.message);
  }
}

testSearch();
