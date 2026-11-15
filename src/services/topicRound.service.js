import LearningSession from '../models/LearningSession.js'

const topicWords = {
  'daily-life': [
    ['schedule', 'noun', 'lịch trình', 'I check my schedule every morning.'],
    ['errand', 'noun', 'việc vặt cần đi làm', 'I run an errand after work.'],
    ['household', 'noun', 'hộ gia đình', 'Everyone in our household helps with cleaning.'],
    ['laundry', 'noun', 'quần áo cần giặt; việc giặt giũ', 'I do the laundry on Sunday.'],
    ['chore', 'noun', 'việc nhà', 'Washing dishes is my daily chore.'],
    ['appointment', 'noun', 'cuộc hẹn', 'I have an appointment with my dentist tomorrow.'],
    ['budget', 'noun', 'ngân sách', 'We plan a weekly budget for groceries.'],
    ['leisure', 'noun', 'thời gian rảnh', 'I enjoy reading in my leisure time.'],
    ['neighborhood', 'noun', 'khu phố', 'My neighborhood has a small park.'],
  ],
  travel: [
    ['destination', 'noun', 'điểm đến', 'Our destination is a quiet coastal town.'],
    ['departure', 'noun', 'sự khởi hành', 'Please arrive before the departure time.'],
    ['accommodation', 'noun', 'chỗ ở', 'We booked accommodation near the beach.'],
    ['reservation', 'noun', 'việc đặt chỗ', 'I made a reservation at a small hotel.'],
    ['luggage', 'noun', 'hành lý', 'Keep your luggage close to you.'],
    ['passport', 'noun', 'hộ chiếu', 'You need a passport to travel abroad.'],
    ['landmark', 'noun', 'địa danh nổi bật', 'The old bridge is a famous landmark.'],
    ['souvenir', 'noun', 'quà lưu niệm', 'I bought a souvenir for my sister.'],
    ['excursion', 'noun', 'chuyến tham quan ngắn', 'We went on an excursion to the island.'],
  ],
  hobbies: [
    ['craft', 'noun', 'hoạt động thủ công', 'Making pottery is a relaxing craft.'],
    ['sketch', 'noun', 'bản phác họa', 'I drew a sketch of my garden.'],
    ['pastime', 'noun', 'thú tiêu khiển', 'Reading is my favorite pastime.'],
    ['rehearsal', 'noun', 'buổi tập dượt', 'Our band has a rehearsal on Friday.'],
    ['exhibition', 'noun', 'cuộc triển lãm', 'We visited an art exhibition.'],
    ['creativity', 'noun', 'sự sáng tạo', 'Painting helps me develop my creativity.'],
    ['photography', 'noun', 'nhiếp ảnh', 'I enjoy photography during my travels.'],
    ['gardening', 'noun', 'việc làm vườn', 'Gardening keeps me active on weekends.'],
    ['collection', 'noun', 'bộ sưu tập', 'My stamp collection includes rare designs.'],
  ],
  technology: [
    ['device', 'noun', 'thiết bị', 'This device tracks my daily activity.'],
    ['privacy', 'noun', 'quyền riêng tư', 'Strong passwords help protect our privacy.'],
    ['automation', 'noun', 'sự tự động hóa', 'Automation reduces repetitive work.'],
    ['software', 'noun', 'phần mềm', 'We update our software regularly.'],
    ['network', 'noun', 'mạng kết nối', 'Our office network connects all computers.'],
    ['database', 'noun', 'cơ sở dữ liệu', 'The database stores customer information.'],
    ['encryption', 'noun', 'sự mã hóa', 'Encryption protects sensitive messages.'],
    ['innovation', 'noun', 'sự đổi mới', 'Innovation can improve everyday life.'],
    ['interface', 'noun', 'giao diện', 'The application has a simple interface.'],
  ],
  environment: [
    ['conservation', 'noun', 'sự bảo tồn', 'Wildlife conservation protects endangered animals.'],
    ['habitat', 'noun', 'môi trường sống', 'Forests provide a habitat for many animals.'],
    ['emission', 'noun', 'sự phát thải', 'The factory monitors each emission of harmful gas.'],
    ['biodiversity', 'noun', 'đa dạng sinh học', 'Rainforests have rich biodiversity.'],
    ['recycling', 'noun', 'việc tái chế', 'Recycling reduces household waste.'],
    ['drought', 'noun', 'hạn hán', 'The drought damaged many crops.'],
    ['ecosystem', 'noun', 'hệ sinh thái', 'A healthy ecosystem supports diverse species.'],
    ['pollution', 'noun', 'ô nhiễm', 'Air pollution affects our health.'],
    ['sustainability', 'noun', 'tính bền vững', 'Sustainability guides our energy choices.'],
  ],
  business: [
    ['revenue', 'noun', 'doanh thu', 'The company increased its revenue this year.'],
    ['proposal', 'noun', 'đề xuất', 'We submitted a proposal to the client.'],
    ['stakeholder', 'noun', 'bên liên quan', 'Each stakeholder can share an opinion.'],
    ['negotiation', 'noun', 'sự đàm phán', 'The negotiation resulted in a fair agreement.'],
    ['investment', 'noun', 'khoản đầu tư', 'The investment helped our business grow.'],
    ['supplier', 'noun', 'nhà cung cấp', 'Our supplier delivers materials every week.'],
    ['contract', 'noun', 'hợp đồng', 'Both companies signed the contract.'],
    ['profit', 'noun', 'lợi nhuận', 'The store earned a small profit.'],
    ['partnership', 'noun', 'quan hệ hợp tác', 'The partnership created new opportunities.'],
  ],
}

export function selectTopicRound(set, sessions = []) {
  const completed = sessions.filter(s => s.status === 'completed' && s.learningSetSlug === set.slug)
  const learned = new Set(completed.flatMap(s => s.targetWords.map(w => (typeof w === 'string' ? w : w.word).toLowerCase())))
  const active = sessions.find(s => s.status === 'in_progress' && s.learningSetSlug === set.slug && s.mode === 'static')
  if (active) return { targetWords: active.targetWords, round: completed.length + 1, isReview: active.targetWords.every(w => learned.has(w.word.toLowerCase())) }
  const pool = [], seen = new Set()
  const add = (item, wordId) => {
    const word = item.word.trim().toLowerCase()
    if (seen.has(word)) return
    seen.add(word)
    pool.push({ ...item, word, wordId })
  }
  set.items.forEach((w, i) => add(w, `${set._id}:${i}`))
  for (const [word, partOfSpeech, definitionVi, example] of topicWords[set.slug] || [])
    add({ word, partOfSpeech, definitionVi, exampleSentences: [example], collocations: [], quizQuestions: [] }, `${set._id}:extra:${word}`)
  const fresh = pool.filter(w => !learned.has(w.word))
  if (fresh.length) return { targetWords: fresh.slice(0, 3), round: completed.length + 1, isReview: false }
  const offset = (completed.length * 3) % Math.max(pool.length, 1)
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)]
  return { targetWords: rotated.slice(0, 3), round: completed.length + 1, isReview: true }
}

export function getTopicRoundSessions(student) {
  return LearningSession.find({ student, mode: 'static', status: { $in: ['completed', 'in_progress'] } })
    .select('learningSetSlug mode status targetWords').lean()
}
