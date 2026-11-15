import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

requireIsolatedTestExecution('seedFullDemo', {
  envFlag: 'ALLOW_DESTRUCTIVE_DEMO_SEED',
})
const seedPassword = process.env.SEED_DEMO_PASSWORD
if (typeof seedPassword !== 'string' || seedPassword.length < 12) {
  throw new Error('Set SEED_DEMO_PASSWORD to a password of at least 12 characters')
}

import connectDB from '../src/config/db.js'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import LearningSet from '../src/models/LearningSet.js'
import Vocabulary from '../src/models/Vocabulary.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'
import Essay from '../src/models/Essay.js'
import EssayRevision from '../src/models/EssayRevision.js'
import LearningSession from '../src/models/LearningSession.js'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import ReviewEvent from '../src/models/ReviewEvent.js'
import WeeklyGoal from '../src/models/WeeklyGoal.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Subscription from '../src/models/Subscription.js'
import PaymentTransaction from '../src/models/PaymentTransaction.js'
import ManualFeedback from '../src/models/ManualFeedback.js'
import Comment from '../src/models/Comment.js'
import Alert from '../src/models/Alert.js'
import Notification from '../src/models/Notification.js'

function formatDate(date) {
  return date.toISOString().split('T')[0]
}

async function seedFullDemo() {
  try {
    console.log('🚀 Connecting to MongoDB...')
    await connectDB()
    console.log('✅ Connected to MongoDB.')

    // ─────────────────────────────────────────────────────────────
    // 1. LEARNING SETS (Rich vocabulary sets)
    // ─────────────────────────────────────────────────────────────
    console.log('🌱 1. Seeding Learning Sets...')
    const learningSetsData = [
      {
        slug: 'daily-life',
        title: 'Daily Life & Productivity',
        description: 'Từ vựng thiết yếu về thói quen hàng ngày, quản lý thời gian và năng suất làm việc.',
        level: 'A2',
        category: 'Daily Life',
        status: 'published',
        items: [
          {
            word: 'routine',
            partOfSpeech: 'noun',
            definitionVi: 'thói quen, chu trình công việc hàng ngày',
            phonetic: '/ruːˈtiːn/',
            collocations: ['daily routine', 'morning routine', 'establish a routine'],
            exampleSentences: ['A consistent morning routine boosts my productivity.'],
            quizQuestions: [],
          },
          {
            word: 'commute',
            partOfSpeech: 'verb',
            definitionVi: 'đi làm, đi học (quãng đường đi lại hàng ngày)',
            phonetic: '/kəˈmjuːt/',
            collocations: ['daily commute', 'commute by bus', 'long commute'],
            exampleSentences: ['I commute to work by bicycle to stay healthy.'],
            quizQuestions: [],
          },
          {
            word: 'productive',
            partOfSpeech: 'adjective',
            definitionVi: 'năng suất, có hiệu quả cao',
            phonetic: '/prəˈdʌktɪv/',
            collocations: ['highly productive', 'productive day', 'productive discussion'],
            exampleSentences: ['Setting clear priorities makes each workday more productive.'],
            quizQuestions: [],
          },
          {
            word: 'efficient',
            partOfSpeech: 'adjective',
            definitionVi: 'hiệu quả, tiết kiệm thời gian và nguồn lực',
            phonetic: '/ɪˈfɪʃnt/',
            collocations: ['efficient way', 'energy efficient', 'highly efficient'],
            exampleSentences: ['An efficient workflow reduces study stress significantly.'],
            quizQuestions: [],
          },
        ],
      },
      {
        slug: 'technology',
        title: 'Technology & Innovation',
        description: 'Từ vựng học thuật về chuyển đổi số, công nghệ giáo dục và đổi mới sáng tạo.',
        level: 'B1',
        category: 'Technology',
        status: 'published',
        items: [
          {
            word: 'innovation',
            partOfSpeech: 'noun',
            definitionVi: 'sự đổi mới, sáng kiến cải tiến',
            phonetic: '/ˌɪnəˈveɪʃn/',
            collocations: ['technological innovation', 'foster innovation', 'breakthrough innovation'],
            exampleSentences: ['Technological innovation is rapidly transforming modern classrooms.'],
            quizQuestions: [],
          },
          {
            word: 'collaboration',
            partOfSpeech: 'noun',
            definitionVi: 'sự cộng tác, hợp tác làm việc nhóm',
            phonetic: '/kəˌlæbəˈreɪʃn/',
            collocations: ['close collaboration', 'foster collaboration', 'team collaboration'],
            exampleSentences: ['Online tools foster seamless collaboration among remote teams.'],
            quizQuestions: [],
          },
          {
            word: 'accessible',
            partOfSpeech: 'adjective',
            definitionVi: 'dễ tiếp cận, dễ sử dụng cho mọi người',
            phonetic: '/əkˈsesəbl/',
            collocations: ['easily accessible', 'widely accessible', 'accessible to everyone'],
            exampleSentences: ['E-learning makes quality education accessible worldwide.'],
            quizQuestions: [],
          },
          {
            word: 'revolutionize',
            partOfSpeech: 'verb',
            definitionVi: 'cách mạng hóa, thay đổi hoàn toàn',
            phonetic: '/ˌrevəˈluːʃənaɪz/',
            collocations: ['revolutionize industry', 'revolutionize learning', 'completely revolutionize'],
            exampleSentences: ['Artificial intelligence continues to revolutionize education systems.'],
            quizQuestions: [],
          },
        ],
      },
      {
        slug: 'health-society',
        title: 'Health, Nutrition & Public Policy',
        description: 'Từ vựng học thuật chuyên sâu về sức khỏe cộng đồng, chế độ ăn và chính sách công.',
        level: 'B2',
        category: 'Health',
        status: 'published',
        items: [
          {
            word: 'subsidize',
            partOfSpeech: 'verb',
            definitionVi: 'trợ cấp, hỗ trợ kinh phí',
            phonetic: '/ˈsʌbsɪdaɪz/',
            collocations: ['subsidize public transport', 'heavily subsidize', 'government subsidizes'],
            exampleSentences: ['Governments should subsidize organic food to encourage healthy diets.'],
            quizQuestions: [],
          },
          {
            word: 'curb',
            partOfSpeech: 'verb',
            definitionVi: 'kiềm chế, kìm hãm, hạn chế',
            phonetic: '/kɜːrb/',
            collocations: ['curb obesity', 'curb inflation', 'curb emissions'],
            exampleSentences: ['Taxing fast food helps curb the consumption of unhealthy snacks.'],
            quizQuestions: [],
          },
          {
            word: 'epidemic',
            partOfSpeech: 'noun',
            definitionVi: 'nạn dịch, đại dịch, sự lan tràn nhanh chóng',
            phonetic: '/ˌepɪˈdemɪk/',
            collocations: ['obesity epidemic', 'curb the epidemic', 'global epidemic'],
            exampleSentences: ['Health officials are tackling a growing epidemic of lifestyle diseases.'],
            quizQuestions: [],
          },
          {
            word: 'sedentary',
            partOfSpeech: 'adjective',
            definitionVi: 'ít vận động, ngồi một chỗ nhiều',
            phonetic: '/ˈsednteri/',
            collocations: ['sedentary lifestyle', 'sedentary job', 'sedentary habits'],
            exampleSentences: ['A sedentary lifestyle increases the risk of chronic cardiovascular conditions.'],
            quizQuestions: [],
          },
          {
            word: 'detrimental',
            partOfSpeech: 'adjective',
            definitionVi: 'có hại, gây thiệt hại',
            phonetic: '/ˌdetrɪˈmentl/',
            collocations: ['detrimental effect', 'detrimental impact', 'highly detrimental'],
            exampleSentences: ['Consuming processed sugar daily has a detrimental effect on long-term wellness.'],
            quizQuestions: [],
          },
          {
            word: 'implement',
            partOfSpeech: 'verb',
            definitionVi: 'thi hành, triển khai, áp dụng',
            phonetic: '/ˈɪmplɪment/',
            collocations: ['implement policies', 'implement measures', 'successfully implement'],
            exampleSentences: ['Schools must implement stricter nutritional guidelines in their cafeterias.'],
            quizQuestions: [],
          },
        ],
      },
    ]

    const learningSets = []
    for (const setData of learningSetsData) {
      const set = await LearningSet.findOneAndUpdate(
        { slug: setData.slug },
        { $set: setData },
        { upsert: true, returnDocument: 'after' }
      )
      learningSets.push(set)
    }
    console.log(`✅ Seeded ${learningSets.length} learning sets.`)

    // ─────────────────────────────────────────────────────────────
    // 2. SUBSCRIPTION PLANS
    // ─────────────────────────────────────────────────────────────
    console.log('💳 2. Seeding Subscription Plans...')
    const plansData = [
      {
        slug: 'student-plus',
        name: 'Student Plus',
        targetRole: 'student',
        tier: 'plus',
        description: 'Nâng cao vốn từ và tốc độ viết luận với trợ lý AI.',
        monthlyPrice: 59000,
        yearlyPrice: 499000,
        features: ['15 bài chấm AI/ngày', 'Flashcard SRS', 'Không giới hạn lớp học'],
        dailyAiEssayLimit: 15,
        maxSponsoredStudents: 0,
        maxClasses: 99,
        isActive: true,
      },
      {
        slug: 'student-pro',
        name: 'Student Pro',
        targetRole: 'student',
        tier: 'pro',
        description: 'Chinh phục IELTS & Viết luận học thuật đỉnh cao.',
        monthlyPrice: 99000,
        yearlyPrice: 799000,
        features: ['Không giới hạn bài viết AI', 'Đánh giá 4 tiêu chí IELTS', 'Xuất báo cáo PDF'],
        dailyAiEssayLimit: 9999,
        maxSponsoredStudents: 0,
        maxClasses: 99,
        highlightBadge: 'Phổ biến nhất',
        isActive: true,
      },
      {
        slug: 'student-ultra',
        name: 'Student Ultra',
        targetRole: 'student',
        tier: 'ultra',
        description: 'Trải nghiệm học tập cá nhân hóa với gia sư AI 1-on-1.',
        monthlyPrice: 169000,
        yearlyPrice: 1299000,
        features: ['Toàn bộ quyền lợi Pro', 'Gia sư AI 1-on-1', 'Băng thông AI ưu tiên'],
        dailyAiEssayLimit: 9999,
        maxSponsoredStudents: 0,
        maxClasses: 99,
        isActive: true,
      },
      {
        slug: 'teacher-plus',
        name: 'Teacher Plus',
        targetRole: 'teacher',
        tier: 'plus',
        description: 'Dành cho giáo viên quản lý các lớp học nhỏ.',
        monthlyPrice: 199000,
        yearlyPrice: 1790000,
        features: ['Bảo trợ 30 học sinh', 'Tạo tối đa 3 lớp học', 'Giao bài tập kèm từ khóa'],
        maxSponsoredStudents: 30,
        maxClasses: 3,
        dailyAiEssayLimit: 9999,
        isActive: true,
      },
      {
        slug: 'teacher-pro',
        name: 'Teacher Pro',
        targetRole: 'teacher',
        tier: 'pro',
        description: 'Dành cho giáo viên chuyên nghiệp & Trung tâm quy mô vừa.',
        monthlyPrice: 499000,
        yearlyPrice: 4490000,
        features: [
          'Bảo trợ miễn phí cho 100 học sinh (dùng quyền Pro)',
          'Tạo tối đa 10 lớp học trực tuyến',
          'Chấm bài luận AI không giới hạn',
          'Bảng điều khiển Class Analytics & Early Warning AI',
          'Xuất báo cáo học tập và bảng điểm Excel/PDF',
        ],
        maxSponsoredStudents: 100,
        maxClasses: 10,
        dailyAiEssayLimit: 9999,
        highlightBadge: 'Khuyên dùng cho GV',
        isActive: true,
      },
      {
        slug: 'teacher-ultra',
        name: 'Teacher Ultra',
        targetRole: 'teacher',
        tier: 'ultra',
        description: 'Giải pháp toàn diện cho Trung tâm Ngoại ngữ & Trường học.',
        monthlyPrice: 999000,
        yearlyPrice: 8990000,
        features: ['Bảo trợ 300+ học sinh', 'Không giới hạn lớp học', 'Trợ lý AI 1-on-1'],
        maxSponsoredStudents: 300,
        maxClasses: 99,
        dailyAiEssayLimit: 9999,
        isActive: true,
      },
    ]

    const seededPlans = {}
    for (const p of plansData) {
      const planDoc = await SubscriptionPlan.findOneAndUpdate(
        { slug: p.slug },
        { $set: p },
        { upsert: true, returnDocument: 'after' }
      )
      seededPlans[p.slug] = planDoc
    }
    console.log(`✅ Seeded ${Object.keys(seededPlans).length} subscription plans.`)

    // ─────────────────────────────────────────────────────────────
    // 3. CORE USERS & 15 STUDENTS ROSTER
    // ─────────────────────────────────────────────────────────────
    console.log('👤 3. Seeding Users (Admin, Teacher, Student, Parent, and Classmates)...')

    // Admin
    let admin = await User.findOne({ email: 'admin@lexigrow.com' })
    if (!admin) {
      admin = new User({ email: 'admin@lexigrow.com' })
    }
    if (admin.isNew) {
      admin.name = 'Hệ Thống Quản Trị'
      admin.role = 'admin'
      admin.password = seedPassword
      admin.accountStatus = 'active'
      await admin.save()
    } else {
      console.log('Existing demo admin left unchanged.')
    }

    // Teacher: Cô Hoàng Mai
    let teacher = await User.findOne({ email: 'teacher@lexigrow.com' })
    if (!teacher) {
      teacher = new User({ email: 'teacher@lexigrow.com' })
    }
    if (teacher.isNew) {
      teacher.name = 'Cô Hoàng Mai'
      teacher.role = 'teacher'
      teacher.password = seedPassword
      teacher.institution = 'Hanoi University of Foreign Studies'
      teacher.accountStatus = 'active'
      await teacher.save()
    } else {
      console.log('Existing demo teacher left unchanged.')
    }

    // Demo Student: Nguyễn Văn Minh
    let student = await User.findOne({ email: 'student@lexigrow.com' })
    if (!student) {
      student = new User({ email: 'student@lexigrow.com' })
    }
    if (student.isNew) {
      student.name = 'Nguyễn Văn Minh'
      student.role = 'student'
      student.password = seedPassword
      student.accountStatus = 'active'
      student.englishLevel = 'B2'
      student.anonymousNickname = 'MinhTech'
      student.learningProfile = {
        interests: ['Technology', 'Environment', 'Health'],
        targetLevel: 'B2',
        dailyGoalMinutes: 15,
        pace: 'standard',
        onboardingCompleted: true,
        timezone: 'Asia/Ho_Chi_Minh',
      }
      await student.save()
    } else {
      console.log('Existing demo student left unchanged.')
    }

    // Parent: Bác Nguyễn Văn Hùng
    let parent = await User.findOne({ email: 'parent@lexigrow.com' })
    if (!parent) {
      parent = new User({ email: 'parent@lexigrow.com' })
    }
    if (parent.isNew) {
      parent.name = 'Nguyễn Văn Hùng'
      parent.role = 'parent'
      parent.password = seedPassword
      parent.accountStatus = 'active'
      parent.children = [student._id]
      await parent.save()
    } else {
      console.log('Existing demo parent left unchanged.')
    }

    // Link Parent & Student
    student.parents = [parent._id]
    await student.save()

    await ParentStudentLink.findOneAndUpdate(
      { parent: parent._id, student: student._id },
      {
        parent: parent._id,
        student: student._id,
        relationship: 'father',
        status: 'active',
      },
      { upsert: true }
    )
    console.log('✅ Linked Parent (Nguyễn Văn Hùng) to Student (Nguyễn Văn Minh).')

    // 14 Other Classmates in the 15-student class
    const classmatesData = [
      { email: 'linh.tran@lexigrow.com', name: 'Trần Thị Mai Linh', level: 'A2' },
      { email: 'hoang.le@lexigrow.com', name: 'Lê Huy Hoàng', level: 'B1' },
      { email: 'quan.do@lexigrow.com', name: 'Đỗ Minh Quân', level: 'B1' },
      { email: 'anh.pham@lexigrow.com', name: 'Phạm Đức Anh', level: 'B2' },
      { email: 'nguyen.vu@lexigrow.com', name: 'Vũ Thảo Nguyên', level: 'B2' },
      { email: 'nhi.hoang@lexigrow.com', name: 'Hoàng Yến Nhi', level: 'B1' },
      { email: 'huy.bui@lexigrow.com', name: 'Bùi Quang Huy', level: 'B1' },
      { email: 'ha.dang@lexigrow.com', name: 'Đặng Thu Hà', level: 'B2' },
      { email: 'bao.trinh@lexigrow.com', name: 'Trịnh Quốc Bảo', level: 'B1' },
      { email: 'anh.ngo@lexigrow.com', name: 'Ngô Phương Anh', level: 'B1' },
      { email: 'bach.duong@lexigrow.com', name: 'Dương Gia Bách', level: 'B2' },
      { email: 'tram.phan@lexigrow.com', name: 'Phan Bảo Trâm', level: 'B2' },
      { email: 'khoi.ly@lexigrow.com', name: 'Lý Minh Khôi', level: 'B1' },
      { email: 'trang.nguyen@lexigrow.com', name: 'Nguyễn Thùy Trang', level: 'B1' },
    ]

    const allStudents = [student]
    for (const cData of classmatesData) {
      let stDoc = await User.findOne({ email: cData.email })
      if (!stDoc) {
        stDoc = new User({ email: cData.email })
      }
      if (stDoc.isNew) {
        stDoc.name = cData.name
        stDoc.role = 'student'
        stDoc.password = seedPassword
        stDoc.englishLevel = cData.level
        stDoc.accountStatus = 'active'
        stDoc.learningProfile = {
          interests: ['Daily Life', 'Education'],
          targetLevel: cData.level,
          dailyGoalMinutes: 10,
          pace: 'standard',
          onboardingCompleted: true,
          timezone: 'Asia/Ho_Chi_Minh',
        }
        await stDoc.save()
      }
      allStudents.push(stDoc)
    }
    console.log(`✅ Seeded 15 students in total (Minh + 14 classmates).`)

    // ─────────────────────────────────────────────────────────────
    // 4. TEACHER SUBSCRIPTION (PRO TIER & SPONSORSHIP) & PAYMENT
    // ─────────────────────────────────────────────────────────────
    console.log('💎 4. Activating Teacher Pro Subscription & PayOS Payment...')
    const teacherPlan = seededPlans['teacher-pro']
    const subStartDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 1 month ago
    const subEndDate = new Date(Date.now() + 335 * 24 * 60 * 60 * 1000) // valid for 11 more months
    const orderCode = 1729000001

    await Subscription.findOneAndUpdate(
      { user: teacher._id },
      {
        user: teacher._id,
        plan: teacherPlan._id,
        planSlug: 'teacher-pro',
        targetRole: 'teacher',
        tier: 'pro',
        billingCycle: 'yearly',
        amountPaid: 4490000,
        orderCode: orderCode,
        startDate: subStartDate,
        endDate: subEndDate,
        status: 'active',
        maxSponsoredStudents: 100,
      },
      { upsert: true }
    )

    await PaymentTransaction.findOneAndUpdate(
      { orderCode: orderCode },
      {
        orderCode: orderCode,
        user: teacher._id,
        plan: teacherPlan._id,
        planSlug: 'teacher-pro',
        planName: 'Teacher Pro (Gói 1 năm)',
        tier: 'pro',
        targetRole: 'teacher',
        billingCycle: 'yearly',
        amount: 4490000,
        status: 'PAID',
        paidAt: subStartDate,
      },
      { upsert: true }
    )
    console.log('✅ Teacher Cô Hoàng Mai is now subscribed to TEACHER-PRO (100 sponsored students quota).')

    // ─────────────────────────────────────────────────────────────
    // 5. CLASS CREATION (All 15 students enrolled)
    // ─────────────────────────────────────────────────────────────
    console.log('🏫 5. Seeding Main Class...')
    const studentIds = allStudents.map((s) => s._id)

    const mainClass = await Class.findOneAndUpdate(
      { code: 'IELTS-65' },
      {
        name: 'IELTS Intensive Writing - Target 6.5+',
        code: 'IELTS-65',
        description: 'Lớp học chuyên sâu kỹ năng viết luận Task 1 & Task 2, mở rộng vốn từ vựng học thuật B2-C1 và phản xạ chấm bài AI.',
        schedule: 'Thứ 3 - Thứ 5 - Thứ 7 (19:30 - 21:00)',
        status: 'active',
        teacher: teacher._id,
        students: studentIds,
      },
      { upsert: true, returnDocument: 'after' }
    )
    console.log(`✅ Seeded Class "${mainClass.name}" with ${studentIds.length} enrolled students.`)

    // ─────────────────────────────────────────────────────────────
    // 6. ASSIGNMENTS
    // ─────────────────────────────────────────────────────────────
    console.log('📝 6. Seeding Assignments...')

    // Assignment 1: Past / Closed (Due 7 days ago on 2026-10-08)
    const assign1Due = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const assign1 = await Assignment.findOneAndUpdate(
      { classId: mainClass._id, title: 'Writing Task 2: Technology and Traditional Skills' },
      {
        classId: mainClass._id,
        teacher: teacher._id,
        learningSetId: learningSets[1]._id, // Technology
        title: 'Writing Task 2: Technology and Traditional Skills',
        description: 'Some people believe that technology has made traditional skills unnecessary. To what extent do you agree or disagree? (Write 150-220 words).',
        dueDate: assign1Due,
        keywords: ['innovation', 'collaboration', 'accessible', 'revolutionize'],
        status: 'closed',
      },
      { upsert: true, returnDocument: 'after' }
    )

    // Assignment 2: Active / Running (Due Next Tuesday, 2026-10-20 at 23:59:59)
    // Note: Simulated current date is Thursday 2026-10-15. Next Tuesday is 2026-10-20.
    const assign2Due = new Date('2026-10-20T23:59:59.000Z')
    const assign2 = await Assignment.findOneAndUpdate(
      { classId: mainClass._id, title: 'Writing Task 2: Fast Food and Public Health Policies' },
      {
        classId: mainClass._id,
        teacher: teacher._id,
        learningSetId: learningSets[2]._id, // Health
        title: 'Writing Task 2: Fast Food and Public Health Policies',
        description: 'Some people believe that taxes should be levied on fast food to reduce obesity and promote public health. To what extent do you agree or disagree? (Write at least 150 words).',
        dueDate: assign2Due,
        keywords: ['subsidize', 'curb', 'epidemic', 'sedentary', 'detrimental', 'implement'],
        status: 'active',
      },
      { upsert: true, returnDocument: 'after' }
    )
    console.log('✅ Seeded Assignment 1 (Closed, due 7 days ago) & Assignment 2 (Active, due next Tuesday 20/10).')

    // ─────────────────────────────────────────────────────────────
    // 7. VOCABULARY & SRS FOR STUDENT MINH (15 words)
    // ─────────────────────────────────────────────────────────────
    console.log('📚 7. Seeding Vocabularies & SRS for Nguyễn Văn Minh...')
    // Clean old vocabs for Minh to ensure exact state
    await Vocabulary.deleteMany({ student: student._id })

    const minDatePast = new Date(Date.now() - 30 * 60 * 1000) // 30 mins ago -> due today!
    const futureDate = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000)

    const minhVocabs = [
      // 6 Due Today (Box 1-2)
      {
        word: 'subsidize',
        category: 'academic',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/ˈsʌbsɪdaɪz/',
        partOfSpeech: 'verb',
        definition: 'Trợ cấp, hỗ trợ kinh phí bằng công quỹ',
        exampleSentence: 'Governments should subsidize organic produce to make nutritious food affordable.',
        synonyms: ['fund', 'sponsor', 'finance'],
        reviewCount: 2,
        reviewInterval: 1,
        easeFactor: 2.3,
        nextReviewDate: minDatePast,
      },
      {
        word: 'curb',
        category: 'academic',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/kɜːrb/',
        partOfSpeech: 'verb',
        definition: 'Kiềm chế, hạn chế, kiểm soát sự phát triển tiêu cực',
        exampleSentence: 'Levying taxes on sugary beverages helps curb childhood obesity.',
        synonyms: ['restrain', 'control', 'suppress'],
        reviewCount: 1,
        reviewInterval: 1,
        easeFactor: 2.4,
        nextReviewDate: minDatePast,
      },
      {
        word: 'epidemic',
        category: 'scientific',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/ˌepɪˈdemɪk/',
        partOfSpeech: 'noun',
        definition: 'Nạn dịch, sự bùng phát nhanh chóng của vấn đề xã hội',
        exampleSentence: 'Health experts are alarmed by the epidemic of sedentary lifestyle diseases.',
        synonyms: ['outbreak', 'plague', 'surge'],
        reviewCount: 2,
        reviewInterval: 1,
        easeFactor: 2.3,
        nextReviewDate: minDatePast,
      },
      {
        word: 'sedentary',
        category: 'academic',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/ˈsednteri/',
        partOfSpeech: 'adjective',
        definition: 'Ít vận động, ngồi nhiều một chỗ',
        exampleSentence: 'A sedentary daily routine significantly increases cardiovascular risks.',
        synonyms: ['inactive', 'desk-bound', 'stationary'],
        reviewCount: 1,
        reviewInterval: 1,
        easeFactor: 2.5,
        nextReviewDate: minDatePast,
      },
      {
        word: 'detrimental',
        category: 'academic',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/ˌdetrɪˈmentl/',
        partOfSpeech: 'adjective',
        definition: 'Gây hại, có tác động tiêu cực nghiêm trọng',
        exampleSentence: 'Excessive consumption of fast food has detrimental effects on physical stamina.',
        synonyms: ['harmful', 'damaging', 'injurious'],
        reviewCount: 2,
        reviewInterval: 1,
        easeFactor: 2.2,
        nextReviewDate: minDatePast,
      },
      {
        word: 'implement',
        category: 'academic',
        theme: 'Health',
        masteryLevel: 'learning',
        ipa: '/ˈɪmplɪment/',
        partOfSpeech: 'verb',
        definition: 'Thi hành, triển khai, thực thi chính sách',
        exampleSentence: 'Educational institutions must implement health-conscious cafeteria menus.',
        synonyms: ['execute', 'enforce', 'apply'],
        reviewCount: 2,
        reviewInterval: 1,
        easeFactor: 2.4,
        nextReviewDate: minDatePast,
      },
      // 9 Mastered / Reviewing in future
      {
        word: 'routine',
        category: 'daily',
        theme: 'Daily Life',
        masteryLevel: 'mastered',
        ipa: '/ruːˈtiːn/',
        partOfSpeech: 'noun',
        definition: 'Thói quen, lịch trình sinh hoạt đều đặn',
        exampleSentence: 'A consistent morning routine helps me stay organized and energetic.',
        synonyms: ['habit', 'schedule', 'custom'],
        reviewCount: 6,
        reviewInterval: 14,
        easeFactor: 2.7,
        nextReviewDate: futureDate(7),
      },
      {
        word: 'commute',
        category: 'daily',
        theme: 'Daily Life',
        masteryLevel: 'mastered',
        ipa: '/kəˈmjuːt/',
        partOfSpeech: 'verb',
        definition: 'Đi lại hàng ngày giữa nơi ở và chỗ làm',
        exampleSentence: 'I prefer to commute by bicycle to maintain personal fitness.',
        synonyms: ['travel', 'journey'],
        reviewCount: 5,
        reviewInterval: 10,
        easeFactor: 2.5,
        nextReviewDate: futureDate(5),
      },
      {
        word: 'productive',
        category: 'academic',
        theme: 'Daily Life',
        masteryLevel: 'mastered',
        ipa: '/prəˈdʌktɪv/',
        partOfSpeech: 'adjective',
        definition: 'Năng suất cao, mang lại nhiều kết quả',
        exampleSentence: 'Prioritizing important tasks makes each study session productive.',
        synonyms: ['fruitful', 'constructive'],
        reviewCount: 5,
        reviewInterval: 12,
        easeFactor: 2.6,
        nextReviewDate: futureDate(8),
      },
      {
        word: 'efficient',
        category: 'academic',
        theme: 'Daily Life',
        masteryLevel: 'mastered',
        ipa: '/ɪˈfɪʃnt/',
        partOfSpeech: 'adjective',
        definition: 'Hiệu quả, tối ưu hóa thời gian và công sức',
        exampleSentence: 'Automating administrative tasks is an efficient way to save time.',
        synonyms: ['effective', 'streamlined'],
        reviewCount: 5,
        reviewInterval: 10,
        easeFactor: 2.6,
        nextReviewDate: futureDate(6),
      },
      {
        word: 'innovation',
        category: 'academic',
        theme: 'Technology',
        masteryLevel: 'mastered',
        ipa: '/ˌɪnəˈveɪʃn/',
        partOfSpeech: 'noun',
        definition: 'Đổi mới, sáng tạo đột phá',
        exampleSentence: 'Continuous innovation in technology reshapes modern pedagogical methods.',
        synonyms: ['novelty', 'modernization', 'breakthrough'],
        reviewCount: 4,
        reviewInterval: 8,
        easeFactor: 2.5,
        nextReviewDate: futureDate(6),
      },
      {
        word: 'collaboration',
        category: 'academic',
        theme: 'Technology',
        masteryLevel: 'mastered',
        ipa: '/kəˌlæbəˈreɪʃn/',
        partOfSpeech: 'noun',
        definition: 'Hợp tác, tinh thần làm việc nhóm',
        exampleSentence: 'Cloud platforms foster international collaboration among researchers.',
        synonyms: ['partnership', 'cooperation', 'teamwork'],
        reviewCount: 4,
        reviewInterval: 9,
        easeFactor: 2.5,
        nextReviewDate: futureDate(7),
      },
      {
        word: 'accessible',
        category: 'academic',
        theme: 'Technology',
        masteryLevel: 'mastered',
        ipa: '/əkˈsesəbl/',
        partOfSpeech: 'adjective',
        definition: 'Dễ tiếp cận, thuận tiện sử dụng',
        exampleSentence: 'Digital libraries make vast archives accessible to remote learners.',
        synonyms: ['available', 'reachable', 'attainable'],
        reviewCount: 4,
        reviewInterval: 7,
        easeFactor: 2.4,
        nextReviewDate: futureDate(5),
      },
      {
        word: 'revolutionize',
        category: 'academic',
        theme: 'Technology',
        masteryLevel: 'mastered',
        ipa: '/ˌrevəˈluːʃənaɪz/',
        partOfSpeech: 'verb',
        definition: 'Cách mạng hóa, tạo biến chuyển căn bản',
        exampleSentence: 'Machine learning tools will revolutionize how students acquire foreign languages.',
        synonyms: ['transform', 'overhaul', 'recast'],
        reviewCount: 4,
        reviewInterval: 11,
        easeFactor: 2.6,
        nextReviewDate: futureDate(9),
      },
      {
        word: 'sustainable',
        category: 'academic',
        theme: 'Environment',
        masteryLevel: 'mastered',
        ipa: '/səˈsteɪnəbl/',
        partOfSpeech: 'adjective',
        definition: 'Bền vững, có thể duy trì lâu dài',
        exampleSentence: 'Adopting sustainable habits ensures the preservation of our natural ecosystem.',
        synonyms: ['viable', 'renewable', 'enduring'],
        reviewCount: 4,
        reviewInterval: 10,
        easeFactor: 2.5,
        nextReviewDate: futureDate(8),
      },
    ]

    const seededMinhVocabs = []
    for (const v of minhVocabs) {
      const doc = await Vocabulary.create({
        ...v,
        student: student._id,
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      })
      seededMinhVocabs.push(doc)
    }
    console.log(`✅ Seeded ${seededMinhVocabs.length} words for Minh (6 due today for SRS flashcard demo!).`)

    // Ensure student Trần Thị Mai Linh has ZERO vocabulary added in past 28 days!
    const linhStudent = allStudents.find((s) => s.email === 'linh.tran@lexigrow.com')
    if (linhStudent) {
      await Vocabulary.deleteMany({ student: linhStudent._id })
      // Seed 2 old words from 40 days ago so Linh's 4-week window count is strictly [0, 0, 0, 0]
      await Vocabulary.create([
        {
          student: linhStudent._id,
          word: 'basic',
          category: 'daily',
          masteryLevel: 'learning',
          definition: 'Cơ bản',
          createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        },
        {
          student: linhStudent._id,
          word: 'simple',
          category: 'daily',
          masteryLevel: 'learning',
          definition: 'Đơn giản',
          createdAt: new Date(Date.now() - 42 * 24 * 60 * 60 * 1000),
        },
      ])
      console.log('✅ Ensured Trần Thị Mai Linh has 0 words in the past 4 weeks (Triggers genuine vocabulary stagnation).')
    }

    // ─────────────────────────────────────────────────────────────
    // 8. ESSAYS, SUBMISSIONS, MANUAL FEEDBACK & COMMENTS
    // ─────────────────────────────────────────────────────────────
    console.log('📄 8. Seeding Essays & Submissions for Assignment 1 and 2...')

    // Clean old essays for these 2 assignments and Minh/class to start completely fresh
    await Essay.deleteMany({
      $or: [
        { assignment: { $in: [assign1._id, assign2._id] } },
        { student: student._id },
        { class: mainClass._id },
      ],
    })

    // Ensure student Minh is only enrolled in the demo class
    await Class.updateMany(
      { _id: { $ne: mainClass._id } },
      { $pull: { students: student._id } }
    )

    // ── ASSIGNMENT 1: 14 students submitted, 1 missed (Trần Thị Mai Linh) ──
    const assign1Students = allStudents.filter((s) => s.email !== 'linh.tran@lexigrow.com')
    let minhAssign1Essay = null

    for (let i = 0; i < assign1Students.length; i++) {
      const st = assign1Students[i]
      const isMinh = st.email === 'student@lexigrow.com'
      const isHoang = st.email === 'hoang.le@lexigrow.com'
      const isQuan = st.email === 'quan.do@lexigrow.com'

      const submittedTime = new Date(assign1Due.getTime() - (i + 1) * 3 * 3600 * 1000)

      let essayTitle = `Traditional Skills and Digital Tools - Essay by ${st.name}`
      let essayContent = `In the contemporary era, modern technology plays an indispensable role in daily life and work. Some argue that traditional artisanal skills are losing their practical relevance due to automated software and machinery. In my opinion, while digital devices undeniably increase efficiency, handcrafted arts and traditional techniques preserve essential cultural heritage and should be sustained.`
      let overallScore = 7.0
      let grammarScore = 7.0

      if (isMinh) {
        essayTitle = 'The Enduring Value of Traditional Craftsmanship in the Digital Age'
        essayContent = `In the contemporary era, rapid technological innovation has fundamentally transformed how human beings work and communicate. While computerized machinery has streamlined production lines and made products universally accessible, some assert that traditional manual skills are becoming obsolete. In my view, although digital automation elevates productivity, traditional craftsmanship possesses irreplaceable cultural and cognitive values.

To begin with, automated systems enhance speed and consistency, allowing global industries to manufacture goods with remarkable precision. Digital collaboration tools and smart software enable professionals to revolutionize conventional design workflows. Consequently, tedious physical tasks are minimized, saving valuable human labor.

Nevertheless, traditional craftsmanship embodies national identity and artistic heritage that algorithms cannot duplicate. Handwoven textiles, artisanal pottery, and classical woodworking require intuitive creativity and cultural narratives passed down through generations. Furthermore, mastering these traditional arts cultivates patience and fine motor discipline among younger learners.

In conclusion, technology should complement rather than extinguish time-honored artisanship. While embracing technological innovation is necessary for economic progress, societies must preserve traditional skills as a priceless testament to human cultural diversity.`
        overallScore = 8.5
        grammarScore = 8.5
      } else if (isHoang) {
        overallScore = 5.5
        grammarScore = 5.0 // Lowest in Hoang's 3-essay decline
      } else if (isQuan) {
        overallScore = 6.0 // Lowest in Quan's 3-essay decline
        grammarScore = 6.5
      } else {
        overallScore = Math.round((6.5 + (i % 3) * 0.5) * 10) / 10
        grammarScore = Math.round((6.5 + (i % 2) * 0.5) * 10) / 10
      }

      const essayDoc = await Essay.create({
        student: st._id,
        class: mainClass._id,
        assignment: assign1._id,
        title: essayTitle,
        content: essayContent,
        theme: 'Technology',
        status: 'reviewed',
        wordCount: essayContent.split(/\s+/).length,
        submittedAt: submittedTime,
      })
      if (isMinh) minhAssign1Essay = essayDoc

      // AI Analysis
      await AIAnalysis.create({
        essay: essayDoc._id,
        overallScore: overallScore,
        scoringMethod: 'llm_holistic_legacy',
        scores: {
          vocabularyDiversity: 0.62,
          grammarAccuracy: grammarScore,
          coherence: 7.5,
          complexityIndex: 7.2,
          lexicalDiversityMtld: 51.0,
        },
        newWordsDetected: ['innovation', 'collaboration', 'accessible', 'revolutionize'],
        suggestions: [
          { type: 'strength', text: 'Clear arguments, well-structured complex sentences, and cohesive paragraph transitions.' },
          { type: 'improvement', text: 'Incorporate more varied linking adverbs to enhance overall coherence and flow.' },
        ],
      })

      // Teacher Manual Feedback for Assignment 1
      const manualFb = await ManualFeedback.create({
        essay: essayDoc._id,
        teacher: teacher._id,
        scores: {
          grammar: grammarScore,
          vocabulary: overallScore,
          coherence: 7.0,
          complexity: 7.0,
        },
        feedbackText: isMinh
          ? 'Well-developed arguments with rich academic vocabulary. Pay attention to controlling complex sentence boundaries in paragraph 2 to avoid run-on sentences.'
          : 'Meets fundamental essay requirements; needs greater focus on sentence transitions and concrete examples.',
        status: 'submitted',
        submittedAt: new Date(submittedTime.getTime() + 12 * 3600 * 1000),
      })

      // Seed real-time Comment thread between Teacher & Minh
      if (isMinh) {
        await Comment.create([
          {
            essay: essayDoc._id,
            user: teacher._id,
            content: 'Well-developed arguments with rich academic vocabulary. Pay attention to controlling complex sentence boundaries in paragraph 2 to avoid run-on sentences.',
            createdAt: new Date(submittedTime.getTime() + 12 * 3600 * 1000),
          },
          {
            essay: essayDoc._id,
            user: student._id,
            content: 'Thank you so much, teacher! I took notes and will practice punctuation and complex conjunctions in the next assignment.',
            createdAt: new Date(submittedTime.getTime() + 14 * 3600 * 1000),
          },
        ])
      }
    }
    console.log(`✅ Seeded 14 reviewed submissions with AI & ManualFeedback for Assignment 1 (Linh missed).`)

    // Seed 2 earlier reviewed essays for Lê Huy Hoàng (to form 3 consecutive declining grammar scores: 7.5 -> 6.5 -> 5.0)
    const hoangStudent = allStudents.find((s) => s.email === 'hoang.le@lexigrow.com')
    if (hoangStudent) {
      // Essay 1 (14 days ago): Grammar 7.5
      const hEssay1 = await Essay.create({
        student: hoangStudent._id,
        class: mainClass._id,
        title: 'Environmental Protection Practices in Modern Urban Centers',
        content: 'Protecting the environment is essential for maintaining global biodiversity. Cities must implement strict recycling guidelines.',
        status: 'reviewed',
        wordCount: 150,
        submittedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      })
      await AIAnalysis.create({
        essay: hEssay1._id,
        overallScore: 7.5,
        scores: { grammarAccuracy: 7.5, vocabularyDiversity: 0.65, coherence: 7.5, complexityIndex: 7.0 },
      })

      // Essay 2 (7 days ago): Grammar 6.5
      const hEssay2 = await Essay.create({
        student: hoangStudent._id,
        class: mainClass._id,
        title: 'The Influence of Social Media on Teenagers',
        content: 'Social media affects teenage communication. While it connects people, many youths spend too much time on digital devices.',
        status: 'reviewed',
        wordCount: 155,
        submittedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
      await AIAnalysis.create({
        essay: hEssay2._id,
        overallScore: 6.8,
        scores: { grammarAccuracy: 6.5, vocabularyDiversity: 0.58, coherence: 6.5, complexityIndex: 6.5 },
      })
      console.log('✅ Seeded 2 previous essays for Lê Huy Hoàng (forming genuine 7.5 -> 6.5 -> 5.0 grammar decline).')
    }

    // Seed 2 earlier reviewed essays for Đỗ Minh Quân (to form 3 consecutive declining overall scores: 7.5 -> 6.8 -> 6.0)
    const quanStudent = allStudents.find((s) => s.email === 'quan.do@lexigrow.com')
    if (quanStudent) {
      const qEssay1 = await Essay.create({
        student: quanStudent._id,
        class: mainClass._id,
        title: 'Urban Public Transportation and Green Mobility',
        content: 'Efficient public transportation reduces road congestion and air pollution in metropolitan areas.',
        status: 'reviewed',
        wordCount: 160,
        submittedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      })
      await AIAnalysis.create({
        essay: qEssay1._id,
        overallScore: 7.5,
        scores: { grammarAccuracy: 7.5, vocabularyDiversity: 0.62, coherence: 7.5, complexityIndex: 7.0 },
      })

      const qEssay2 = await Essay.create({
        student: quanStudent._id,
        class: mainClass._id,
        title: 'Renewable Energy Solutions for Developing Nations',
        content: 'Solar and wind power offer sustainable alternatives to fossil fuels in modern emerging economies.',
        status: 'reviewed',
        wordCount: 155,
        submittedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
      await AIAnalysis.create({
        essay: qEssay2._id,
        overallScore: 6.8,
        scores: { grammarAccuracy: 7.0, vocabularyDiversity: 0.58, coherence: 6.5, complexityIndex: 6.5 },
      })
      console.log('✅ Seeded 2 previous essays for Đỗ Minh Quân (forming genuine 7.5 -> 6.8 -> 6.0 overall decline).')
    }

    // ── ASSIGNMENT 2: 9 submitted, 6 pending ──
    // CRITICAL: Nguyễn Văn Minh submitted 15 MINUTES AGO (newest in class -> #1 on top)
    const assign2SubmittedEmails = [
      'student@lexigrow.com', // 15 mins ago (TOP #1)
      'anh.pham@lexigrow.com', // 4 hours ago
      'nguyen.vu@lexigrow.com', // 8 hours ago
      'nhi.hoang@lexigrow.com', // 1 day ago
      'huy.bui@lexigrow.com', // 1.5 days ago
      'ha.dang@lexigrow.com', // 2 days ago
      'bao.trinh@lexigrow.com', // 2.5 days ago
      'anh.ngo@lexigrow.com', // 3 days ago
      'hoang.le@lexigrow.com', // 3.5 days ago
    ]

    const timeOffsetsMs = [
      15 * 60 * 1000, // 15 minutes ago (Minh)
      4 * 3600 * 1000,
      8 * 3600 * 1000,
      24 * 3600 * 1000,
      36 * 3600 * 1000,
      48 * 3600 * 1000,
      60 * 3600 * 1000,
      72 * 3600 * 1000,
      84 * 3600 * 1000,
    ]

    let minhAssign2Essay = null

    for (let i = 0; i < assign2SubmittedEmails.length; i++) {
      const email = assign2SubmittedEmails[i]
      const st = allStudents.find((s) => s.email === email)
      if (!st) continue

      const isMinh = email === 'student@lexigrow.com'
      const submittedAt = new Date(Date.now() - timeOffsetsMs[i])

      let title = `Taxing Fast Food for Public Health - by ${st.name}`
      let content = `In recent years, lifestyle-related diseases have sparked heated discussions about national nutrition. Many suggest that governments should levy higher taxes on fast food products. In my opinion, this fiscal intervention can curb excessive fast food consumption and encourage healthier dietary choices.`
      let score = 7.0

      if (isMinh) {
        title = 'Public Health Policies and Taxation on Fast Food Consumption'
        content = `In recent years, the escalating epidemic of obesity and lifestyle-related diseases has sparked intense debate over dietary habits. A growing number of experts argue that governments should levy higher taxes on fast food products. In my opinion, I firmly agree with this fiscal policy as an effective method to curb unhealthy food consumption, provided that revenues are utilized to subsidize nutritious alternatives.

First and foremost, taxing junk food creates a direct economic deterrent against detrimental eating patterns. When sugary beverages and processed meals become more expensive, consumers, especially teenagers and working-class citizens, naturally reduce their intake. Simultaneously, public authorities must implement comprehensive educational campaigns to encourage physical activity, counteracting sedentary modern lifestyles.

However, taxation alone cannot eliminate malnutrition. Governments must also subsidize organic farming and fresh produce to make healthy choices accessible and affordable. In conclusion, imposing fast food taxes is a constructive policy that directly addresses health crises while funding nationwide wellness initiatives.`
        score = 8.2 // IELTS ~Band 7.5
      }

      const essayDoc = await Essay.create({
        student: st._id,
        class: mainClass._id,
        assignment: assign2._id,
        title: title,
        content: content,
        theme: 'Health',
        status: 'submitted', // Ready for teacher to review live!
        wordCount: content.split(/\s+/).length,
        submittedAt: submittedAt,
      })

      if (isMinh) minhAssign2Essay = essayDoc

      // AI Analysis
      await AIAnalysis.create({
        essay: essayDoc._id,
        overallScore: score,
        scoringMethod: 'llm_holistic_legacy',
        scores: {
          vocabularyDiversity: isMinh ? 0.58 : 0.52,
          grammarAccuracy: isMinh ? 8.5 : 7.0,
          coherence: isMinh ? 8.0 : 7.0,
          complexityIndex: isMinh ? 7.8 : 6.8,
          lexicalDiversityMtld: isMinh ? 52.4 : 44.0,
        },
        newWordsDetected: isMinh
          ? ['subsidize', 'curb', 'epidemic', 'sedentary', 'detrimental', 'implement']
          : ['curb', 'dietary'],
        suggestions: [
          {
            type: 'strength',
            text: 'Accurately applies all target academic vocabulary items within appropriate social argumentative contexts.',
          },
          {
            type: 'strength',
            text: 'Well-balanced essay structure: clear thesis statement, two logically reasoned body paragraphs, and a precise conclusion.',
          },
          {
            type: 'improvement',
            text: 'Consider incorporating empirical health statistics or authoritative citations to enhance argumentative persuasion.',
          },
        ],
      })
    }
    console.log(`✅ Seeded 9 submitted essays for Assignment 2.`)
    console.log(`🌟 MINH'S SUBMISSION IS PLACED AT THE VERY TOP (Submitted 15 mins ago)!`)

    // 6 Pending students (Drafts or not submitted)
    const pendingEmails = [
      'linh.tran@lexigrow.com',
      'quan.do@lexigrow.com',
      'bach.duong@lexigrow.com',
      'tram.phan@lexigrow.com',
      'khoi.ly@lexigrow.com',
      'trang.nguyen@lexigrow.com',
    ]

    for (const email of pendingEmails.slice(0, 2)) {
      const st = allStudents.find((s) => s.email === email)
      if (st) {
        await Essay.create({
          student: st._id,
          class: mainClass._id,
          assignment: assign2._id,
          title: `[Bản nháp] Fast food tax thoughts - ${st.name}`,
          content: 'I think taxing fast food is good because people eat too much oily food...',
          theme: 'Health',
          status: 'draft',
          wordCount: 18,
        })
      }
    }
    console.log('✅ Seeded 6 pending student statuses for Assignment 2.')

    // ─────────────────────────────────────────────────────────────
    // 9. EARLY WARNING ALERTS (100% Mathematically Backed by Real Data)
    // ─────────────────────────────────────────────────────────────
    console.log('⚠️ 9. Seeding Early Warning Alerts for Cô Hoàng Mai...')
    await Alert.deleteMany({ teacher: teacher._id })

    const alertsToSeed = [
      {
        student: linhStudent._id, // Trần Thị Mai Linh
        class: mainClass._id,
        teacher: teacher._id,
        type: 'critical',
        metric: 'vocabulary_stagnation',
        detail: 'Học sinh Trần Thị Mai Linh không ghi nhận thêm từ vựng mới nào trong 4 tuần liên tiếp (0 từ mới). Vốn từ vựng đang bị đình trệ nghiêm trọng.',
        icon: 'warning',
        isRead: false,
        isResolved: false,
        createdAt: new Date(Date.now() - 2 * 3600 * 1000),
      },
      {
        student: linhStudent._id, // Trần Thị Mai Linh
        class: mainClass._id,
        teacher: teacher._id,
        type: 'warning',
        metric: 'missed_assignment_deadline',
        detail: 'Học sinh Trần Thị Mai Linh đã bỏ lỡ hạn nộp bài "Writing Task 2: Technology and Traditional Skills" (Hạn chót: 08/10/2026).',
        icon: 'schedule',
        isRead: false,
        isResolved: false,
        createdAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
      {
        student: hoangStudent._id, // Lê Huy Hoàng
        class: mainClass._id,
        teacher: teacher._id,
        type: 'critical',
        metric: 'grammar_decline',
        detail: 'Điểm ngữ pháp của học sinh Lê Huy Hoàng có xu hướng giảm liên tục qua 3 bài luận gần nhất (7.5 ➔ 6.5 ➔ 5.0, giảm tổng cộng -2.5 điểm). Cần giáo viên can thiệp hướng dẫn.',
        icon: 'assignment_late',
        isRead: false,
        isResolved: false,
        createdAt: new Date(Date.now() - 5 * 3600 * 1000),
      },
      {
        student: quanStudent._id, // Đỗ Minh Quân
        class: mainClass._id,
        teacher: teacher._id,
        type: 'warning',
        metric: 'overall_score_decline',
        detail: 'Điểm bài luận trung bình của Đỗ Minh Quân giảm liên tục qua 3 bài gần nhất (7.5 ➔ 6.8 ➔ 6.0). Cần lưu ý về độ mạch lạc và cấu trúc bài viết.',
        icon: 'trending_down',
        isRead: true,
        isResolved: false,
        createdAt: new Date(Date.now() - 48 * 3600 * 1000),
      },
    ]

    for (const a of alertsToSeed) {
      await Alert.create(a)
    }
    console.log(`✅ Seeded 4 Early Warning Alerts strictly backed by real student records (No false alerts on Minh).`)

    // ─────────────────────────────────────────────────────────────
    // 10. NOTIFICATIONS FOR STUDENT & PARENT
    // ─────────────────────────────────────────────────────────────
    console.log('🔔 10. Seeding Notifications...')
    await Notification.deleteMany({ recipient: { $in: [student._id, parent._id] } })

    await Notification.create([
      {
        recipient: student._id,
        sender: teacher._id,
        title: 'Giáo viên đã nhận xét bài viết',
        message: 'Cô Hoàng Mai đã chấm điểm và phản hồi bài viết "Writing Task 2: Technology and Traditional Skills". Điểm: 7.0/10.',
        type: 'feedback',
        link: `/student/feedback?id=${minhAssign1Essay._id}`,
        isRead: false,
        createdAt: new Date(Date.now() - 6 * 24 * 3600 * 1000),
      },
      {
        recipient: student._id,
        sender: teacher._id,
        title: 'Bài tập mới được giao',
        message: 'Cô Hoàng Mai đã giao bài tập mới: "Writing Task 2: Fast Food and Public Health Policies". Hạn nộp: 20/10/2026.',
        type: 'assignment',
        link: `/student/class/${mainClass._id}`,
        isRead: true,
        createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      },
      {
        recipient: parent._id,
        sender: student._id,
        title: 'Học sinh hoàn thành bài tập',
        message: 'Con bạn, Nguyễn Văn Minh, vừa nộp bài luận "Writing Task 2: Fast Food and Public Health Policies" và đạt phân tích AI 8.2 điểm.',
        type: 'parent_notice',
        link: `/parent/child/${student._id}`,
        isRead: false,
        createdAt: new Date(Date.now() - 15 * 60 * 1000),
      },
    ])
    console.log('✅ Seeded clean notifications for Student & Parent.')

    // ─────────────────────────────────────────────────────────────
    // 11. REVIEW EVENTS (7-day Active Streak for Minh) & WEEKLY GOAL
    // ─────────────────────────────────────────────────────────────
    console.log('📈 11. Seeding Review Events (7-day Streak) & Weekly Goal for Minh...')
    await ReviewEvent.deleteMany({ student: student._id })

    const reviewHistory = [
      { daysAgo: 6, words: ['routine', 'commute'], rating: 4 },
      { daysAgo: 5, words: ['productive', 'efficient'], rating: 4 },
      { daysAgo: 4, words: ['routine', 'productive'], rating: 4 },
      { daysAgo: 3, words: ['innovation', 'collaboration'], rating: 3 },
      { daysAgo: 2, words: ['accessible', 'revolutionize'], rating: 4 },
      { daysAgo: 1, words: ['subsidize', 'curb'], rating: 3 },
      { daysAgo: 0, words: ['routine', 'commute', 'productive'], rating: 4 },
    ]

    for (const rh of reviewHistory) {
      const date = new Date(Date.now() - rh.daysAgo * 24 * 60 * 60 * 1000)
      for (const w of rh.words) {
        const vocab = seededMinhVocabs.find((v) => v.word === w)
        if (vocab) {
          await ReviewEvent.create({
            student: student._id,
            vocabulary: vocab._id,
            rating: rh.rating,
            reviewedAt: date,
            easeFactor: vocab.easeFactor,
            intervalAfter: vocab.reviewInterval,
            repetition: vocab.reviewCount,
            requestId: `seed_req_${crypto.randomUUID()}`,
            source: 'self_rating',
          })
        }
      }
    }
    console.log('✅ Seeded 7-day active streak of ReviewEvents.')

    // Weekly Goal
    const now = new Date()
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)) // Monday
    startOfWeek.setHours(0, 0, 0, 0)

    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 6)
    endOfWeek.setHours(23, 59, 59, 999)

    await WeeklyGoal.findOneAndUpdate(
      { student: student._id, weekStart: startOfWeek },
      {
        student: student._id,
        weekStart: startOfWeek,
        weekEnd: endOfWeek,
        goals: [
          { label: 'Từ vựng mới', target: 15, current: 11, icon: 'book', color: 'primary' },
          { label: 'Bài viết luận', target: 2, current: 2, icon: 'edit', color: 'success' },
          { label: 'Thời gian học (phút)', target: 90, current: 75, icon: 'clock', color: 'amber' },
        ],
      },
      { upsert: true }
    )
    console.log('✅ Seeded Weekly Goal (11/15 words, 2/2 essays, 75/90 mins).')

    // ─────────────────────────────────────────────────────────────
    // 12. WORD USAGE EVIDENCE (For Mastery Pipeline & Vocabulary Proof)
    // ─────────────────────────────────────────────────────────────
    console.log('🎯 12. Seeding WordUsageEvidence items...')
    const evidenceWords = [
      { word: 'subsidize', sentence: 'Governments must also subsidize organic farming and fresh produce to make healthy choices accessible and affordable.' },
      { word: 'curb', sentence: 'In my opinion, I firmly agree with this fiscal policy as an effective method to curb unhealthy food consumption.' },
      { word: 'epidemic', sentence: 'In recent years, the escalating epidemic of obesity and lifestyle-related diseases has sparked intense debate over dietary habits.' },
      { word: 'sedentary', sentence: 'Simultaneously, public authorities must implement comprehensive educational campaigns to counteract sedentary modern lifestyles.' },
      { word: 'detrimental', sentence: 'First and foremost, taxing junk food creates a direct economic deterrent against detrimental eating patterns.' },
      { word: 'implement', sentence: 'Public authorities must implement comprehensive educational campaigns to encourage physical activity.' },
    ]

    if (minhAssign2Essay) {
      for (const ew of evidenceWords) {
        await WordUsageEvidence.findOneAndUpdate(
          { student: student._id, word: ew.word, contextSentence: ew.sentence },
          {
            student: student._id,
            word: ew.word,
            contextSentence: ew.sentence,
            essayId: minhAssign2Essay._id,
            theme: 'Health',
            meaning: 'Accurately utilized in IELTS Task 2 essay context',
            isVerifiedCorrect: true,
            assisted: false,
            aiConfidenceScore: 0.96,
            usedAt: new Date(Date.now() - 15 * 60 * 1000),
            localDay: formatDate(new Date()),
          },
          { upsert: true }
        )
      }
      console.log(`✅ Seeded ${evidenceWords.length} WordUsageEvidence items linked to Minh's latest essay.`)
    }

    console.log('\n=================================================================')
    console.log('🎉 MASTER DEMO DATA SEEDED 100% SUCCESSFULLY!')
    console.log('=================================================================')
    console.log('Demo account passwords are set from SEED_DEMO_PASSWORD; credentials are not printed.')
    console.log('🏫 Class:   IELTS Intensive Writing - Target 6.5+ (15 Students)')
    console.log('📅 Deadlines: Assign 1 (Closed 08/10), Assign 2 (Due Tue 20/10 23:59:59)')
    console.log('=================================================================\n')

    process.exit(0)
  } catch (error) {
    console.error('❌ Error during master database seed:', error)
    process.exit(1)
  }
}

seedFullDemo()
