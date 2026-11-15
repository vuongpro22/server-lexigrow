import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import mongoose from 'mongoose'
import { assertLocalTestMongoUri } from './localTestDatabaseGuard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

if (process.env.NODE_ENV !== 'test') {
  throw new Error('seedDemoQuotas is restricted to NODE_ENV=test')
}
if (process.env.RUN_SEED_DEMO_QUOTAS !== 'true') {
  throw new Error('Set RUN_SEED_DEMO_QUOTAS=true to run this mutating demo seed')
}
assertLocalTestMongoUri(process.env.MONGO_URI, 'seedDemoQuotas', 'lexigrow_dev5_test')
const DEMO_PASSWORD = process.env.SEED_DEMO_QUOTAS_PASSWORD
const DEMO_TEACHER_EMAIL = process.env.SEED_DEMO_TEACHER_EMAIL
const DEMO_FREE_STUDENT_EMAIL = process.env.SEED_DEMO_FREE_STUDENT_EMAIL
const DEMO_STUDENT_PREFIX = process.env.SEED_DEMO_STUDENT_PREFIX
if (![DEMO_TEACHER_EMAIL, DEMO_FREE_STUDENT_EMAIL].every(email => typeof email === 'string' && email.endsWith('@example.test'))
  || !/^test[_-][a-z0-9_-]+$/i.test(DEMO_STUDENT_PREFIX || '')) {
  throw new Error('Set demo seed accounts to isolated @example.test emails and a test-only student prefix')
}
if (typeof DEMO_PASSWORD !== 'string' || DEMO_PASSWORD.length < 12 || DEMO_PASSWORD.length > 128) {
  throw new Error('Set SEED_DEMO_QUOTAS_PASSWORD to a 12-128 character local test password')
}

import connectDB from '../src/config/db.js'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import { getTeacherStudentQuota, assertStudentCapacity } from '../src/services/studentQuota.service.js'
import { getUserEffectiveTier, checkDailyEssayQuota } from '../src/services/tier.service.js'


async function seedDemoQuotas() {
  try {
    await connectDB()
    console.log('MongoDB connected successfully to the isolated local test database.')

    const now = new Date()

    // =========================================================================
    // 1. SETUP SUBSCRIPTION PLAN: teacher-plus (max 30 sponsored students)
    // =========================================================================
    console.log('\n--- 1. Cấu hình gói Teacher Plus (30 học sinh) ---')
    let teacherPlusPlan = await SubscriptionPlan.findOne({ slug: 'dev5-demo-teacher-plus' })
    if (!teacherPlusPlan) {
      teacherPlusPlan = await SubscriptionPlan.create({
        slug: 'dev5-demo-teacher-plus',
        name: 'Teacher Plus',
        targetRole: 'teacher',
        tier: 'plus',
        description: 'Gói giáo viên tiêu chuẩn - bảo trợ tối đa 30 học sinh.',
        monthlyPrice: 199000,
        yearlyPrice: 1990000,
        features: [
          'Tối đa 30 học sinh được bảo trợ AI Plus',
          'Tạo tối đa 5 lớp học',
          'Học sinh được chấm 15 bài AI/ngày',
          'Theo dõi tiến độ học sinh thời gian thực',
        ],
        maxSponsoredStudents: 30,
        maxClasses: 5,
        dailyAiEssayLimit: 15,
        highlightBadge: 'Phổ biến',
        isActive: true,
      })
      console.log('Đã tạo mới SubscriptionPlan: teacher-plus (30 học sinh)')
    } else {
      teacherPlusPlan.maxSponsoredStudents = 30
      teacherPlusPlan.dailyAiEssayLimit = 15
      teacherPlusPlan.isActive = true
      await teacherPlusPlan.save()
      console.log('Đã cập nhật SubscriptionPlan: teacher-plus -> maxSponsoredStudents = 30')
    }

    // =========================================================================
    // 2. SETUP TEACHER ACCOUNT & ACTIVE SUBSCRIPTION
    // =========================================================================
    console.log(`\n--- 2. Cấu hình tài khoản Teacher (${DEMO_TEACHER_EMAIL}) ---`)
    let teacher = await User.findOne({ email: DEMO_TEACHER_EMAIL })
    if (teacher && (teacher.role !== 'teacher' || teacher.accountStatus !== 'active' || teacher.isVerified !== true)) {
      throw new Error('Configured teacher demo account must already be an active, verified teacher')
    }
    if (!teacher) {
      teacher = await User.create({
        name: 'Cô Hoàng Mai',
        email: DEMO_TEACHER_EMAIL,
        password: DEMO_PASSWORD,
        role: 'teacher',
        institution: 'THPT Chuyên Hà Nội - Amsterdam',
        isVerified: true,
        accountStatus: 'active',
      })
      console.log(`Đã tạo tài khoản giáo viên: ${DEMO_TEACHER_EMAIL}`)
    } else {
      console.log(`Dùng tài khoản giáo viên test hiện hữu, giữ nguyên password và hồ sơ: ${DEMO_TEACHER_EMAIL}`)
    }

    // Active subscription: 30 sponsored students
    const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    await Subscription.deleteMany({ user: teacher._id, planSlug: /^dev5-demo-/ })
    const teacherSub = await Subscription.create({
      user: teacher._id,
      plan: teacherPlusPlan._id,
      planSlug: 'dev5-demo-teacher-plus',
      targetRole: 'teacher',
      tier: 'plus',
      billingCycle: 'yearly',
      amountPaid: 1990000,
      orderCode: 1729000030,
      startDate: thirtyDaysAgo,
      endDate: oneYearLater,
      status: 'active',
      maxSponsoredStudents: 30,
    })
    console.log(`Đã cấp gói Teacher Plus cho ${teacher.email} (Hạn mức bảo trợ: 30 học sinh)`)

    // =========================================================================
    // 3. SEED EXACTLY 30 UNIQUE STUDENTS INTO TEACHER'S CLASS
    // =========================================================================
    console.log(`\n--- 3. Seed 30 học sinh vào lớp học của giáo viên ---`)
    const studentIds = []

    // Use only explicitly namespaced test accounts; never adopt arbitrary existing students.
    const studentNames = [
      'Nguyễn Văn Minh', 'Trần Thị Mai Linh', 'Lê Huy Hoàng', 'Đỗ Minh Quân', 'Phạm Đức Anh',
      'Vũ Thảo Nguyên', 'Hoàng Yến Nhi', 'Bùi Quang Huy', 'Đặng Thu Hà', 'Trịnh Quốc Bảo',
      'Ngô Phương Anh', 'Dương Gia Bách', 'Phan Bảo Trâm', 'Lý Minh Khôi', 'Nguyễn Thùy Trang',
      'Trần Văn An', 'Lê Thị Bình', 'Phạm Văn Cường', 'Vũ Thị Dung', 'Hoàng Văn Em',
      'Bùi Thị Giang', 'Đặng Văn Hùng', 'Trịnh Thị Hương', 'Ngô Văn Khang', 'Dương Thị Lan',
      'Phan Văn Nam', 'Lý Thị Oanh', 'Nguyễn Văn Phúc', 'Trần Thị Quỳnh', 'Lê Văn Sơn',
    ]

    for (let i = 0; i < 30; i++) {
      const pad = String(i + 1).padStart(2, '0')
      const email = `${DEMO_STUDENT_PREFIX}${pad}@example.test`

      let student = await User.findOne({ email })
      if (student && (student.role !== 'student' || student.accountStatus !== 'active' || student.isVerified !== true)) {
        throw new Error(`Configured student test account must already be active and verified: ${email}`)
      }
      if (!student) {
        student = await User.create({
          name: studentNames[i] || `Học sinh ${pad}`,
          email,
          password: DEMO_PASSWORD,
          role: 'student',
          englishLevel: 'B1',
          isVerified: true,
          accountStatus: 'active',
        })
      }
      studentIds.push(student._id)
    }

    console.log(`Đã chuẩn bị 30 học sinh (${DEMO_STUDENT_PREFIX}01..30@example.test)`)

    // Seed student 31 (outside class) to test adding student block
    let student31 = await User.findOne({ email: `${DEMO_STUDENT_PREFIX}31@example.test` })
    if (student31 && (student31.role !== 'student' || student31.accountStatus !== 'active' || student31.isVerified !== true)) {
      throw new Error('Configured student-31 test account must already be active and verified')
    }
    if (!student31) {
      student31 = await User.create({
        name: 'Học sinh 31 (Demo Add Block)',
        email: `${DEMO_STUDENT_PREFIX}31@example.test`,
        password: DEMO_PASSWORD,
        role: 'student',
        englishLevel: 'B2',
        isVerified: true,
        accountStatus: 'active',
      })
      console.log(`Đã tạo học sinh 31: ${DEMO_STUDENT_PREFIX}31@example.test (dùng để demo thêm học sinh bị chặn)`)
    } else {
      console.log(`Dùng tài khoản student-31 test hiện hữu, giữ nguyên password và hồ sơ: ${DEMO_STUDENT_PREFIX}31@example.test`)
    }

    // Assign 30 students to Teacher's class
    const demoClassName = '[DEV5-DEMO] IELTS Intensive Writing - Target 6.5+'
    let teacherClass = await Class.findOne({ teacher: teacher._id, code: 'TEST-I30', status: 'active' })
    if (teacherClass && !teacherClass.name.startsWith('[DEV5-DEMO]')) {
      throw new Error('Refusing to replace a non-demo class using the reserved TEST-I30 code')
    }
    if (!teacherClass) {
      teacherClass = await Class.create({
        name: demoClassName,
        code: 'TEST-I30',
        description: 'Lớp luyện viết chuyên sâu mục tiêu IELTS 6.5+ với AI phân tích.',
        teacher: teacher._id,
        students: studentIds,
        pendingStudents: [student31._id],
        status: 'active',
      })
      console.log('Đã tạo lớp học mới với 30 học sinh và 1 yêu cầu chờ duyệt (student31)')
    } else {
      teacherClass.name = demoClassName
      teacherClass.students = studentIds
      teacherClass.pendingStudents = [student31._id]
      teacherClass.status = 'active'
      await teacherClass.save()
      console.log(`Đã cập nhật lớp "${teacherClass.name}": 30 học sinh enrolled, 1 pending (student31)`)
    }

    // Verify Teacher Quota
    const quotaCheck = await getTeacherStudentQuota(teacher._id)
    const distinctStudents = await Class.distinct('students', { teacher: teacher._id, status: 'active' })
    console.log(`\n[KIỂM CHỨNG QUOTA GIÁO VIÊN]`)
    console.log(`- Giới hạn gói giáo viên: ${quotaCheck.limit} học sinh`)
    console.log(`- Số học sinh hiện có trong các lớp active: ${distinctStudents.length} học sinh`)
    console.log(`- Trạng thái slot còn lại: ${Math.max(0, quotaCheck.limit - distinctStudents.length)} slot`)

    try {
      await assertStudentCapacity(teacherClass, [student31._id])
      console.error('❌ LỖI: assertStudentCapacity không chặn khi thêm học sinh thứ 31!')
    } catch (err) {
      console.log(`✅ CHẶN THÀNH CÔNG học sinh thứ 31: "${err.message}" (HTTP ${err.statusCode})`)
    }

    // =========================================================================
    // 4. SETUP FREE STUDENT ACCOUNT (Hit 3/3 daily AI essay grading limit)
    // =========================================================================
    console.log('\n--- 4. Cấu hình học sinh Free đã dùng 3/3 lần chấm AI hôm nay ---')
    const freeStudentEmail = DEMO_FREE_STUDENT_EMAIL
    let freeStudent = await User.findOne({ email: freeStudentEmail })
    if (freeStudent && (freeStudent.role !== 'student' || freeStudent.accountStatus !== 'active' || freeStudent.isVerified !== true)) {
      throw new Error('Configured Free demo account must already be an active, verified student')
    }
    if (freeStudent && (freeStudent.role !== 'student' || freeStudent.accountStatus !== 'active' || freeStudent.isVerified !== true)) {
      throw new Error('Configured Free demo account must already be an active, verified student')
    }
    if (!freeStudent) {
      freeStudent = await User.create({
        name: 'Học sinh Free Demo (Hết lượt AI)',
        email: freeStudentEmail,
        password: DEMO_PASSWORD,
        role: 'student',
        englishLevel: 'B1',
        isVerified: true,
        accountStatus: 'active',
      })
      console.log(`Đã tạo tài khoản học sinh free: ${freeStudentEmail}`)
    } else {
      console.log(`Dùng tài khoản học sinh Free test hiện hữu, giữ nguyên password và hồ sơ: ${freeStudentEmail}`)
    }

    // Ensure free student has no personal active subscription
    await Subscription.deleteMany({ user: freeStudent._id, planSlug: /^dev5-demo-/ })
    // Ensure free student is NOT in any active teacher class
    await Class.updateMany(
      { students: freeStudent._id, code: 'TEST-I30' },
      { $pull: { students: freeStudent._id } }
    )

    // Clean existing essays today for this free student to ensure exact 3 essays
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const oldDemoEssays = await Essay.find({ student: freeStudent._id, title: /^\[DEV5-QUOTA-DEMO\]/ }).select('_id')
    const oldDemoEssayIds = oldDemoEssays.map((essay) => essay._id)
    if (oldDemoEssayIds.length) {
      await Promise.all([
        AIAnalysis.deleteMany({ essay: { $in: oldDemoEssayIds } }),
        Essay.deleteMany({ _id: { $in: oldDemoEssayIds } }),
      ])
    }

    // Create 3 submitted/reviewed essays today
    const essayTopics = [
      {
        title: 'The Impact of Artificial Intelligence on Modern Education',
        content: `Artificial intelligence is rapidly transforming the landscape of modern education across the globe. Today, students have unprecedented access to personalized learning tools, adaptive testing systems, and intelligent tutoring assistants. These technological innovations enable learners to study at their own pace, receive immediate feedback on their assignments, and focus on their specific areas of weakness. Furthermore, educators can automate administrative tasks such as grading and attendance tracking, allowing them to devote more quality time to individualized mentorship. However, over-reliance on AI tools might hinder the development of critical thinking and creative problem-solving skills among younger generations. Therefore, an effective educational framework must balance digital efficiency with genuine human interaction and independent analytical thought.`,
        submittedAt: new Date(startOfToday.getTime() + 1000 * 60 * 60 * 2), // 2h AM today
        ieltsBand: 6.5,
        cefrLevel: 'B2',
      },
      {
        title: 'Climate Change and Renewable Energy Solutions',
        content: `Global climate change represents one of the most pressing challenges confronting humanity in the twenty-first century. Rising sea levels, extreme weather events, and catastrophic biodiversity loss clearly indicate that our reliance on fossil fuels is unsustainable. Transitioning to renewable energy sources, particularly solar, wind, and hydroelectric power, is essential for mitigating carbon emissions. Many forward-thinking nations have already invested heavily in green technology infrastructure, creating sustainable jobs while reducing national carbon footprints. Nevertheless, renewable energy systems require substantial upfront capital investment and reliable storage technologies to handle intermittent supply. In conclusion, combating climate change demands international cooperation, rigorous environmental policies, and sustained public commitment toward clean energy alternatives.`,
        submittedAt: new Date(startOfToday.getTime() + 1000 * 60 * 60 * 5), // 5h AM today
        ieltsBand: 7.0,
        cefrLevel: 'C1',
      },
      {
        title: 'Online Learning vs Traditional Classroom Education',
        content: `The debate between virtual learning and traditional classroom instruction has intensified significantly in recent years. Online education provides unmatched flexibility, allowing students to access high-quality lectures from prestigious international universities regardless of geographical barriers. Additionally, digital platforms offer self-paced learning modules that accommodate diverse schedules and professional commitments. Conversely, traditional physical classrooms provide invaluable social environments where students cultivate interpersonal relationships, participate in spontaneous discussions, and develop teamwork competencies. Direct face-to-face interaction with passionate teachers also fosters accountability and discipline that many self-guided online students struggle to maintain. Ultimately, a blended educational model combining digital flexibility with in-person collaboration represents the optimal path for contemporary education.`,
        submittedAt: new Date(startOfToday.getTime() + 1000 * 60 * 60 * 8), // 8h AM today
        ieltsBand: 6.5,
        cefrLevel: 'B2',
      },
    ]

    for (let i = 0; i < essayTopics.length; i++) {
      const topic = essayTopics[i]
      const essay = await Essay.create({
        student: freeStudent._id,
        title: `[DEV5-QUOTA-DEMO] ${topic.title}`,
        content: topic.content,
        status: 'reviewed',
        theme: 'Academic',
        wordCount: topic.content.split(/\s+/).filter(Boolean).length,
        paragraphCount: 1,
        sentenceCount: 6,
        readingTime: 2,
        submittedAt: topic.submittedAt,
        aiAnalysisStatus: 'completed',
      })

      await AIAnalysis.create({
        essay: essay._id,
        cefrLevel: topic.cefrLevel,
        ieltsBand: topic.ieltsBand,
        overallScore: topic.ieltsBand,
        isFallback: false,
        isTeacherGraded: false,
        scoringMethod: 'weighted_v1',
        rubricVersion: 'rubric-v2-fixed-criteria',
        suggestions: [
          {
            type: 'strength',
            text: 'Well-structured essay with strong academic vocabulary and clear topic sentences.',
            quote: '',
            suggestedRevision: '',
          },
          {
            type: 'improvement',
            text: 'Consider adding more diverse transition phrases between sentences to improve coherence.',
            quote: '',
            suggestedRevision: '',
          },
        ],
      })
    }
    console.log('Đã tạo 3 bài viết submitted/reviewed hôm nay kèm kết quả AI analysis đầy đủ')

    // Create 1 draft essay ready for testing submission
    const draftEssay = await Essay.create({
      student: freeStudent._id,
      title: '[DEV5-QUOTA-DEMO] Benefits of Learning a Second Language in Childhood',
      content: `<p>Learning a second language during early childhood provides numerous cognitive, academic, and social advantages. Research shows that bilingual children often develop stronger problem-solving skills, enhanced creativity, and greater mental flexibility compared to their monolingual peers. Furthermore, acquiring a new language at an early age is significantly easier due to the brain's natural neuroplasticity. Children exposed to diverse linguistic environments also develop greater cultural empathy, better communication competence, and open-mindedness toward people from different backgrounds. In our interconnected world, multilingualism serves as an essential foundation for future academic success and global career opportunities.</p>`,
      status: 'draft',
      theme: 'Education',
      wordCount: 95,
      paragraphCount: 1,
      sentenceCount: 5,
      readingTime: 1,
      aiAnalysisStatus: 'idle',
    })
    console.log(`Đã tạo 1 bài viết nháp (draft): "${draftEssay.title}" (ID: ${draftEssay._id}) để sẵn sàng bấm "Nộp Bài Luận"`)

    // Verify student quota check
    const studentEffectiveTier = await getUserEffectiveTier(freeStudent)
    const studentQuota = await checkDailyEssayQuota(freeStudent)

    console.log(`\n[KIỂM CHỨNG QUOTA HỌC SINH FREE]`)
    console.log(`- Gói hiện tại: ${studentEffectiveTier.planName} (${studentEffectiveTier.tier})`)
    console.log(`- Giới hạn AI essay/ngày: ${studentQuota.limit} bài/ngày`)
    console.log(`- Số bài đã chấm hôm nay: ${studentQuota.usedToday} bài`)
    console.log(`- Số bài còn lại: ${studentQuota.remaining} bài`)
    console.log(`- Có được nộp tiếp không: ${studentQuota.canSubmit ? 'CÓ' : 'KHÔNG (ĐÃ CHẶN)'}`)

    if (!studentQuota.canSubmit && studentQuota.usedToday >= 3) {
      console.log('✅ HỌC SINH FREE ĐÃ ĐẠT GIỚI HẠN 3/3 VÀ SẼ BỊ CHẶN KHI SUBMIT!')
    } else {
      console.error('❌ LỖI: Học sinh chưa bị chặn!')
    }

    console.log('\n===============================================================')
    console.log('                     THÔNG TIN TÀI KHOẢN DEMO                  ')
    console.log('===============================================================')
    console.log('1. TÀI KHOẢN GIÁO VIÊN (DEMO CHẶN THÊM HỌC SINH VƯỢT QUOTA 30):')
    console.log(`   - Email: ${DEMO_TEACHER_EMAIL}`)
    console.log('   - Mật khẩu: giá trị SEED_DEMO_QUOTAS_PASSWORD trong môi trường test')
    console.log('   - Gói: Teacher Plus test (30 học sinh được bảo trợ)')
    console.log(`   - Lớp test: "${demoClassName}" (Code: TEST-I30)`)
    console.log(`   - Tài khoản học sinh vượt quota: ${DEMO_STUDENT_PREFIX}31@example.test`)
    console.log('   - Cách demo chặn: dùng fixture test trên môi trường development/test cô lập.')
    console.log('\n2. TÀI KHOẢN HỌC SINH FREE (DEMO CHẶN CHẤM BÀI AI 3 LẦN/NGÀY):')
    console.log(`   - Email: ${DEMO_FREE_STUDENT_EMAIL}`)
    console.log('   - Mật khẩu: giá trị SEED_DEMO_QUOTAS_PASSWORD trong môi trường test')
    console.log('   - Gói: Free (3 bài AI/ngày)')
    console.log('   - Trạng thái hôm nay: Đã nộp & chấm xong 3 bài luận')
    console.log('   - Cách demo chặn:')
    console.log('     + Vào "Bài viết của tôi" -> Mở bài nháp "Benefits of Learning a Second Language in Childhood"')
    console.log('     + Bấm "Nộp Bài Luận" (hoặc viết bài mới > 50 từ rồi nộp)')
    console.log('     + Hệ thống báo lỗi: "Daily AI essay limit reached (3)." (HTTP 429)')
    console.log('===============================================================\n')

    await mongoose.disconnect()
    process.exit(0)
  } catch (err) {
    console.error('Error during seeding:', err)
    await mongoose.disconnect()
    process.exit(1)
  }
}

seedDemoQuotas()
