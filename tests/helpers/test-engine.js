/**
 * Plain-JS query-engine row for the Loader composition test: the rc.7 engine
 * leaves full-text search abstract, and Loader entries import at runtime, so
 * this helper must stay JavaScript (the typed programs never see it; the
 * snapshot paths only need the concrete reads).
 */
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

export default class TestSessionQueryEngine extends SessionQueryEngine {
  searchSessions() {
    return Promise.resolve({ items: [] })
  }

  searchEvents(...args) {
    return this.readSurface(args[0].sessionId).then(surface => ({
      session: surface.session,
      items: [],
    }))
  }
}
