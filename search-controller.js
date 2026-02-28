require('dotenv').config();
const axios = require('axios');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const SERP_API_KEY = process.env.SERP_API_KEY;

const SEARCH_CACHE = new Map();
const CACHE_TTL = 3600000; // 1 hour

class SearchProvider {
  constructor() {
    this.provider = 'tavily';
  }

  async search(query, options = {}) {
    throw new Error('Not implemented');
  }

  parseResults(rawResults) {
    throw new Error('Not implemented');
  }
}

class TavilyProvider extends SearchProvider {
  constructor() {
    super();
    this.provider = 'tavily';
    this.baseUrl = 'https://api.tavily.com';
  }

  async search(query, options = {}) {
    const { maxResults = 5, includeAnswer = true } = options;

    // Check cache
    const cacheKey = `${query}_${maxResults}`;
    if (SEARCH_CACHE.has(cacheKey)) {
      const cached = SEARCH_CACHE.get(cacheKey);
      if (Date.now() - cached.cachedAt < CACHE_TTL) {
        return { ...cached.results, cached: true };
      }
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/search`,
        {
          api_key: TAVILY_API_KEY,
          query,
          max_results: maxResults,
          include_answer: includeAnswer,
          include_raw_content: false,
          include_images: false
        },
        {
          timeout: 10000
        }
      );

      const results = this.parseResults(response.data, query);
      
      // Cache results
      SEARCH_CACHE.set(cacheKey, {
        results,
        cachedAt: Date.now()
      });

      return results;
    } catch (error) {
      console.error('Tavily search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  parseResults(data, query) {
    const results = (data.results || []).slice(0, 10).map((result, index) => ({
      index: index + 1,
      title: result.title || 'Untitled',
      url: result.url,
      content: result.content || result.snippet || '',
      domain: new URL(result.url || 'https://example.com').hostname,
      publishedDate: result.published_date || null,
      score: result.score || 0
    }));

    return {
      query,
      answer: data.answer || null,
      results,
      totalResults: results.length,
      provider: 'tavily'
    };
  }
}

class SerpAPIProvider extends SearchProvider {
  constructor() {
    super();
    this.provider = 'serp';
    this.baseUrl = 'https://serpapi.com/search';
  }

  async search(query, options = {}) {
    const { maxResults = 5 } = options;

    const cacheKey = `serp_${query}_${maxResults}`;
    if (SEARCH_CACHE.has(cacheKey)) {
      const cached = SEARCH_CACHE.get(cacheKey);
      if (Date.now() - cached.cachedAt < CACHE_TTL) {
        return { ...cached.results, cached: true };
      }
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          api_key: SERP_API_KEY,
          q: query,
          num: maxResults,
          gl: 'us',
          hl: 'en'
        },
        timeout: 10000
      });

      const results = this.parseResults(response.data, query);
      
      SEARCH_CACHE.set(cacheKey, {
        results,
        cachedAt: Date.now()
      });

      return results;
    } catch (error) {
      console.error('SerpAPI search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  parseResults(data) {
    const results = (data.organic_results || []).slice(0, 10).map((result, index) => ({
      index: index + 1,
      title: result.title,
      url: result.link,
      content: result.snippet || '',
      domain: new URL(result.link).hostname,
      publishedDate: result.date || null,
      score: result.relevance_score || 0
    }));

    return {
      query: data.search_parameters?.q || '',
      answer: null,
      results,
      totalResults: results.length,
      provider: 'serp'
    };
  }
}

class BraveSearchProvider extends SearchProvider {
  constructor() {
    super();
    this.provider = 'brave';
    this.baseUrl = 'https://api.search.brave.com/res/v1/web/search';
  }

  async search(query, options = {}) {
    const { maxResults = 5 } = options;

    const cacheKey = `brave_${query}_${maxResults}`;
    if (SEARCH_CACHE.has(cacheKey)) {
      const cached = SEARCH_CACHE.get(cacheKey);
      if (Date.now() - cached.cachedAt < CACHE_TTL) {
        return { ...cached.results, cached: true };
      }
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          q: query,
          count: maxResults
        },
        headers: {
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      const results = this.parseResults(response.data, query);
      
      SEARCH_CACHE.set(cacheKey, {
        results,
        cachedAt: Date.now()
      });

      return results;
    } catch (error) {
      console.error('Brave search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  parseResults(data) {
    const results = (data.web?.results || []).slice(0, 10).map((result, index) => ({
      index: index + 1,
      title: result.title,
      url: result.url,
      content: result.description || '',
      domain: new URL(result.url).hostname,
      publishedDate: result.age || null,
      score: 0
    }));

    return {
      query: data.query?.query || '',
      answer: null,
      results,
      totalResults: results.length,
      provider: 'brave'
    };
  }
}

function getSearchProvider(engine = 'tavily') {
  const providers = {
    tavily: TavilyProvider,
    serp: SerpAPIProvider,
    brave: BraveSearchProvider
  };
  
  const ProviderClass = providers[engine] || TavilyProvider;
  return new ProviderClass();
}

async function runWebSearch(query, options = {}) {
  const {
    engine = 'tavily',
    maxResults = 5,
    includeAnswer = true
  } = options;

  const provider = getSearchProvider(engine);
  return await provider.search(query, { maxResults, includeAnswer });
}

function shouldTriggerSearch(userInput) {
  const input = userInput.toLowerCase().trim();
  
  const temporalKeywords = [
    'latest', 'recent', 'current', 'today', 'yesterday', 
    'news', '2024', '2025', '2026', 'price', 'stock', 'weather',
    'currency', 'exchange rate', 'trending', 'top ', 'best ',
    'newest', 'updated', 'this week', 'this month', 'now'
  ];

  const domainKeywords = [
    'search for', 'look up', 'find information', 'what is',
    'who is', 'how to', 'why does', 'compare ', 'vs ',
    'find me', 'tell me about', 'what are', 'what\'s the'
  ];

  if (input.startsWith('search:') || input.startsWith('web:')) {
    return true;
  }

  const hasTemporal = temporalKeywords.some(kw => input.includes(kw));
  if (hasTemporal) return true;

  const hasDomain = domainKeywords.some(kw => input.includes(kw));
  if (hasDomain) return true;

  if (input.includes('?') && input.split('?')[0].length > 15) {
    return true;
  }

  if (input.length > 50 && /\d+/.test(input)) {
    return true;
  }

  return false;
}

function extractSearchQuery(userInput) {
  let query = userInput.trim();
  
  query = query.replace(/^(search:|web:)\s*/i, '');
  
  const removePatterns = [
    /^(please |could you |can you )?search (for |)/i,
    /^(please |could you |can you )?look up/i,
    /^(please |could you |can you )?find (information |me |)/i,
    /^(what is |what's |who is |who's )/i,
    /^(how (do i|to|does|would) /i,
    /^(tell me about |give me info on )/i
  ];

  for (const pattern of removePatterns) {
    query = query.replace(pattern, '');
  }

  return query.trim();
}

function buildSearchContext(searchResults) {
  if (!searchResults || !searchResults.results) {
    return '';
  }

  let context = '\n\nCURRENT WEB SEARCH RESULTS:\n';

  if (searchResults.answer) {
    context += `AI SUMMARY: ${searchResults.answer}\n\n`;
  }

  context += 'WEB RESULTS:\n';
  
  searchResults.results.forEach((result, idx) => {
    context += `[${idx + 1}] ${result.title}\n`;
    context += `    Source: ${result.url}\n`;
    context += `    ${result.content.substring(0, 300)}...\n\n`;
  });

  return context;
}

function addSourceCitations(response, searchResults) {
  if (!searchResults || !searchResults.results) {
    return response;
  }

  let citedResponse = response;
  
  const citationPatterns = [
    { regex: /\[(\d+)\]/g, results: searchResults.results },
    { regex: /(source|website|according to)/gi, results: searchResults.results }
  ];

  if (searchResults.results.length > 0 && !/\[\d+\]/.test(response)) {
    const sources = searchResults.results.slice(0, 3).map((r, i) => 
      `[${i + 1}] ${r.title} - ${r.domain}`
    ).join('\n');
    
    citedResponse += `\n\n**Sources:**\n${sources}`;
  }

  return citedResponse;
}

function formatSourcesForDisplay(searchResults) {
  if (!searchResults || !searchResults.results) {
    return [];
  }

  return searchResults.results.map((result, index) => ({
    number: index + 1,
    title: result.title,
    url: result.url,
    domain: result.domain,
    content: result.content.substring(0, 200) + (result.content.length > 200 ? '...' : ''),
    publishedDate: result.publishedDate
  }));
}

module.exports = {
  runWebSearch,
  shouldTriggerSearch,
  extractSearchQuery,
  buildSearchContext,
  addSourceCitations,
  formatSourcesForDisplay,
  getSearchProvider,
  SearchProvider,
  TavilyProvider,
  SerpAPIProvider,
  BraveSearchProvider
};
