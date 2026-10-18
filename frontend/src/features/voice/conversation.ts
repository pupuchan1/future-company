/** Conversational intent is separate from measured audio (which drives motion). */
export type ConversationState = 'listening' | 'user' | 'waiting' | 'assistant' | 'both'

export class ConversationActivity {
  private inputUntil = 0
  private outputUntil = 0
  private awaiting = false
  private inputAcceptedAt = -Infinity
  reset() { this.inputUntil = 0; this.outputUntil = 0; this.awaiting = false; this.inputAcceptedAt = -Infinity }
  acceptInput(now = Date.now()) { this.awaiting = true; this.inputAcceptedAt = now }
  awaitResponse() { this.awaiting = true }
  fail() { this.awaiting = false }
  sample(input: number, output: number, audible: boolean, muted: boolean, now = Date.now()): ConversationState {
    if (muted) this.inputUntil = 0
    else if (input >= .012) this.inputUntil = now + 350
    if (!audible) this.outputUntil = 0
    else if (output >= .012) {
      this.outputUntil = now + 650
      // Do not consume a new input while the user is interrupting old output.
      if (now >= this.inputUntil && now - this.inputAcceptedAt >= 350) this.awaiting = false
    }
    const user = now < this.inputUntil
    const assistant = now < this.outputUntil
    return user && assistant ? 'both' : user ? 'user' : assistant ? 'assistant' : this.awaiting ? 'waiting' : 'listening'
  }
}
