import LearningSession from '../models/LearningSession.js'
import PracticeAttempt from '../models/PracticeAttempt.js'
import asyncHandler from '../utils/asyncHandler.js'
import {
  fail,
  objectId,
  text,
  integer,
  requestKey,
  normalizeAnswer,
} from '../utils/learning.js'
import { transactIntent } from '../services/learningTransaction.service.js'
export const submitPractice = asyncHandler(async (req, res) => {
  const b = req.body,
    sessionId = objectId(b.sessionId, 'sessionId')
  let wordId = typeof b.wordId === 'string' && b.wordId.trim() ? text(b.wordId, 'wordId', 100) : ''
  if (!wordId && !b.questionId) {
    fail('Invalid wordId')
  }
  const answer = text(b.answer ?? b.selectedAnswer, 'answer'),
    key = requestKey(req)
  if (!['multiple_choice', 'fill_in_blank'].includes(b.questionType))
    fail('Invalid questionType')
  const questionIndex = integer(b.questionIndex, 0, 0, 20)
  if (b.usedHint !== undefined && typeof b.usedHint !== 'boolean')
    fail('Invalid usedHint')
  const payload = {
    sessionId: String(sessionId),
    wordId,
    answer,
    questionType: b.questionType,
    questionIndex,
    ...(b.questionId ? { questionId: text(b.questionId, 'questionId', 200) } : {}),
    timeSpentMs: integer(b.timeSpentMs, 0, 0, 3600000),
    usedHint: b.usedHint === true,
  }
  const out = await transactIntent(
    req.user._id,
    'practice',
    key,
    payload,
    async (tx) => {
      const session = await LearningSession.findOne({
        _id: sessionId,
        student: req.user._id,
      }).session(tx)
      if (!session) fail('Session not found', 404)
      if (
        session.status !== 'in_progress' ||
        session.currentStep !== 'practice'
      )
        fail('Session is not in practice step', 409)

      const normalizeWordKey = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim()

      // LEARN-15: If wordId is missing but questionId is given, resolve wordId from practiceQuestions
      if (!wordId && b.questionId) {
        const pq = session.practiceQuestions?.find(q => q.id === b.questionId)
        if (pq) {
          const normPqWord = normalizeWordKey(pq.word)
          const matchedTarget = session.targetWords.find(tw => normalizeWordKey(typeof tw === 'string' ? tw : tw.word) === normPqWord)
          if (matchedTarget) {
            wordId = matchedTarget.wordId || (matchedTarget._id ? String(matchedTarget._id) : matchedTarget.word)
          } else {
            wordId = pq.wordId || pq.word
          }
        }
      }
      if (!wordId) fail('Invalid wordId')

      let word = session.targetWords.find((w) => w.wordId === wordId || (w._id && String(w._id) === wordId))
      if (!word) {
        // Fallback: match by normalized word string if wordId was sent as word or matched word
        const targetNorm = normalizeWordKey(wordId)
        word = session.targetWords.find((w) =>
          normalizeWordKey(typeof w === 'string' ? w : w.word) === targetNorm ||
          normalizeWordKey(w.wordId) === targetNorm ||
          (w._id && String(w._id) === wordId)
        )
      }
      let question = word?.quizQuestions?.filter(
        (q) => q.type === b.questionType.replaceAll('_', '-'),
      )[questionIndex]
      // AI questions are graded from the persisted session snapshot, never client answers.
      if (b.questionId) {
        const foundQ = session.practiceQuestions?.find(q =>
          q.id === b.questionId &&
          q.type === b.questionType
        )
        if (!foundQ) {
          fail('Question not found. Reload practice questions.', 404)
        }
        const normPqWord = normalizeWordKey(foundQ.word)
        if (!word || normalizeWordKey(typeof word === 'string' ? word : word.word) !== normPqWord) {
          const matchedTarget = session.targetWords.find(tw => normalizeWordKey(typeof tw === 'string' ? tw : tw.word) === normPqWord)
          if (matchedTarget) {
            word = matchedTarget
            wordId = matchedTarget.wordId || (matchedTarget._id ? String(matchedTarget._id) : matchedTarget.word)
          }
        }
        question = { ...foundQ, type: foundQ.type.replaceAll('_', '-') }
      }
      // Older learning sets and adaptive words may have no authored quiz.
      // Grade the same basic vocabulary questions from the session snapshot.
      if (!b.questionId && word && !word.quizQuestions?.length && questionIndex === 0) {
        if (b.questionType === 'multiple_choice') {
          const meaning = word.definitionVi || word.meaningVi || word.meaning
          if (meaning) question = {
            type: 'multiple-choice',
            correctAnswer: meaning,
            options: [meaning, ...session.targetWords.filter(w => w.wordId !== wordId).map(w => w.definitionVi || w.meaningVi || w.meaning),
              'Freedom and autonomy', 'Leadership capability', 'Novel experience', 'Growth and expansion'],
          }
        } else if (word.exampleSentences?.[0] || word.exampleSentence) {
          question = { type: 'fill-in-blank', correctAnswer: word.word }
        }
      }
      if (!question) fail('Question not found', 404)
      if (
        question.type === 'multiple-choice' &&
        !question.options.includes(answer)
      )
        fail('Answer is not an option')
      const [attempt] = await PracticeAttempt.create(
        [
          {
            ...payload,
            wordId,
            session: sessionId,
            student: req.user._id,
            word: word?.word || (typeof word === 'string' ? word : wordId),
            selectedAnswer: answer,
            isCorrect:
              normalizeAnswer(answer) ===
              normalizeAnswer(question.correctAnswer),
            requestId: key,
          },
        ],
        { session: tx },
      )
      // A write to the session serializes submissions with step transitions.
      session.markModified('updatedAt')
      session.updatedAt = new Date()
      await session.save({ session: tx })
      return {
        ...attempt.toObject(),
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
      }
    },
  )
  res.status(out.replayed ? 200 : 201).json({ success: true, data: out.result })
})
