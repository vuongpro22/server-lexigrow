import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { assertLocalTestMongoUri } from './localTestDatabaseGuard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

const seedPassword = process.env.SEED_PRO_ACCOUNTS_PASSWORD
const studentProEmail = process.env.SEED_PRO_STUDENT_EMAIL
const teacherProEmail = process.env.SEED_PRO_TEACHER_EMAIL
const studentPlanSlug = 'dev5-demo-student-pro'
const teacherPlanSlug = 'dev5-demo-teacher-pro'
if (process.env.NODE_ENV !== 'test') {
  throw new Error('seedProAccounts is restricted to NODE_ENV=test')
}
if (process.env.RUN_SEED_PRO_ACCOUNTS !== 'true') {
  throw new Error('Set RUN_SEED_PRO_ACCOUNTS=true to run this demo seed')
}
assertLocalTestMongoUri(process.env.MONGO_URI, 'seedProAccounts', 'lexigrow_dev5_test')
if (typeof seedPassword !== 'string' || seedPassword.length < 12) {
  throw new Error('Set SEED_PRO_ACCOUNTS_PASSWORD to a password of at least 12 characters')
}
if (![studentProEmail, teacherProEmail].every((email) => /^[a-z0-9._+-]+@example\.test$/i.test(email || ''))) {
  throw new Error('Set SEED_PRO_STUDENT_EMAIL and SEED_PRO_TEACHER_EMAIL to isolated @example.test accounts')
}
import connectDB from '../src/config/db.js'
import User from '../src/models/User.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import { getUserEffectiveTier } from '../src/services/tier.service.js'

async function seedProAccounts() {
  try {
    await connectDB()
    console.log('MongoDB connected successfully.\n')

    // 1. Ensure Subscription Plans exist
    let studentProPlan = await SubscriptionPlan.findOne({ slug: studentPlanSlug })
    if (!studentProPlan) {
      studentProPlan = await SubscriptionPlan.create({
        slug: studentPlanSlug,
        name: 'Student Pro',
        targetRole: 'student',
        tier: 'pro',
        description: 'Chinh phục IELTS & Viết luận học thuật đỉnh cao.',
        monthlyPrice: 99000,
        yearlyPrice: 799000,
        features: [
          'Không giới hạn bài viết luận & phân tích AI',
          'Đánh giá 4 tiêu chí chuẩn IELTS Band 8.5+',
          'Gợi ý nâng cấp từ vựng Collocations & Ngữ pháp nâng cao',
          'So sánh tiến độ giữa các bản sửa (Revision Compare)',
          'Xuất báo cáo học tập PDF chuyên nghiệp',
          'Ưu tiên tốc độ phản hồi AI siêu tốc',
        ],
        dailyAiEssayLimit: 9999,
        maxSponsoredStudents: 0,
        maxClasses: 99,
        highlightBadge: 'Phổ biến nhất',
        sortOrder: 2,
        isActive: true,
      })
      console.log('Created SubscriptionPlan: student-pro')
    }

    let teacherProPlan = await SubscriptionPlan.findOne({ slug: teacherPlanSlug })
    if (!teacherProPlan) {
      teacherProPlan = await SubscriptionPlan.create({
        slug: teacherPlanSlug,
        name: 'Teacher Pro',
        targetRole: 'teacher',
        tier: 'pro',
        description: 'Dành cho giáo viên chuyên nghiệp & trung tâm tiếng Anh.',
        monthlyPrice: 349000,
        yearlyPrice: 2990000,
        features: [
          'Bảo trợ miễn phí cho tối đa 60 học sinh (dùng quyền Pro không giới hạn)',
          'Tạo tối đa 10 lớp học trực tuyến',
          'Phân tích lỗi sai từ vựng toàn diện theo lớp (Class Lexical Heatmap)',
          'Cảnh báo sớm học sinh có nguy cơ hổng kiến thức',
          'Xuất báo cáo tiến độ học tập cho phụ huynh định kỳ',
          'Ưu tiên giải đáp thắc mắc chuyên môn 24/7',
        ],
        maxSponsoredStudents: 60,
        maxClasses: 10,
        dailyAiEssayLimit: 9999,
        highlightBadge: 'Được tin dùng',
        sortOrder: 2,
        isActive: true,
      })
      console.log('Created SubscriptionPlan: teacher-pro')
    }

    // 2. Upsert Student Pro
    let studentProUser = await User.findOne({ email: studentProEmail })
    if (studentProUser && (studentProUser.role !== 'student' || studentProUser.accountStatus !== 'active' || studentProUser.isVerified !== true)) {
      throw new Error('Configured Student Pro fixture must already be an active, verified student')
    }

    if (!studentProUser) {
      studentProUser = await User.create({
        name: 'Lê Minh Pro (Học Sinh Pro)',
        email: studentProEmail,
        password: seedPassword,
        role: 'student',
        isVerified: true,
        institution: 'LexiGrow Academy Pro',
        learningProfile: {
          targetLevel: 'B2',
          dailyGoalMinutes: 20,
          onboardingCompleted: true,
          interests: ['technology', 'business', 'travel'],
        },
      })
      console.log(`Created user: ${studentProEmail}`)
    } else {
      console.log(`Existing user left unchanged: ${studentProEmail}`)
    }

    // Create 1-year active subscription for Student Pro
    const oneYearLater = new Date()
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1)

    const studentSubscription = await Subscription.findOne({ user: studentProUser._id, planSlug: studentPlanSlug })
    if (!studentSubscription) {
      await Subscription.create({
        user: studentProUser._id,
        plan: studentProPlan._id,
        planSlug: studentProPlan.slug,
        targetRole: 'student',
        tier: 'pro',
        billingCycle: 'yearly',
        amountPaid: 799000,
        orderCode: Math.floor(100000 + Math.random() * 900000),
        startDate: new Date(),
        endDate: oneYearLater,
        status: 'active',
        maxSponsoredStudents: 0,
      })
    }
    console.log(`Ensured Pro subscription for ${studentProEmail}`)

    // 3. Upsert Teacher Pro
    let teacherProUser = await User.findOne({ email: teacherProEmail })
    if (teacherProUser && (teacherProUser.role !== 'teacher' || teacherProUser.accountStatus !== 'active' || teacherProUser.isVerified !== true)) {
      throw new Error('Configured Teacher Pro fixture must already be an active, verified teacher')
    }

    if (!teacherProUser) {
      teacherProUser = await User.create({
        name: 'Thầy Hùng Pro (Giáo Viên Pro)',
        email: teacherProEmail,
        password: seedPassword,
        role: 'teacher',
        isVerified: true,
        institution: 'Trung Tâm Tiếng Anh LexiGrow Master',
      })
      console.log(`Created user: ${teacherProEmail}`)
    } else {
      console.log(`Existing user left unchanged: ${teacherProEmail}`)
    }

    // Create a demo subscription only when this exact demo plan is not already present.
    const teacherSubscription = await Subscription.findOne({ user: teacherProUser._id, planSlug: teacherPlanSlug })
    if (!teacherSubscription) {
      await Subscription.create({
        user: teacherProUser._id,
        plan: teacherProPlan._id,
        planSlug: teacherProPlan.slug,
        targetRole: 'teacher',
        tier: 'pro',
        billingCycle: 'yearly',
        amountPaid: 2990000,
        orderCode: Math.floor(100000 + Math.random() * 900000),
        startDate: new Date(),
        endDate: oneYearLater,
        status: 'active',
        maxSponsoredStudents: 60,
      })
    }
    console.log(`Ensured Pro subscription for ${teacherProEmail}`)

    // Existing accounts are intentionally left unchanged.

    // 4. List ALL accounts and their effective tiers
    console.log('\n===============================================================')
    console.log('            DANH SÁCH TOÀN BỘ TÀI KHOẢN TRONG HỆ THỐNG          ')
    console.log('===============================================================\n')

    const allUsers = await User.find({}).sort({ role: 1, email: 1 }).lean()
    
    for (const u of allUsers) {
      if (![studentProEmail, teacherProEmail].includes(u.email)) continue
      const tierInfo = await getUserEffectiveTier(u)
      const expires = tierInfo.expiresAt ? new Date(tierInfo.expiresAt).toLocaleDateString('vi-VN') : 'Vĩnh viễn (Free)'
      console.log(`- [${u.role.toUpperCase()}] ${u.email}`)
      console.log(`  Họ tên: ${u.name}`)
      console.log(`  Gói cước: ${tierInfo.planName || tierInfo.tier.toUpperCase()} (${tierInfo.tier})`)
      console.log(`  Hạn mức AI: ${tierInfo.dailyAiEssayLimit === 9999 ? 'Không giới hạn (Unlimited)' : tierInfo.dailyAiEssayLimit + ' bài/ngày'}`)
      console.log(`  Hạn dùng: ${expires}`)
      console.log('---------------------------------------------------------------')
    }

    process.exit(0)
  } catch (error) {
    console.error('Error seeding pro accounts:', error)
    process.exit(1)
  }
}

seedProAccounts()
