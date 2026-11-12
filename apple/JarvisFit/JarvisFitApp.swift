import SwiftUI

@main
struct JarvisFitApp: App {
    init() {
        // Stile barre di navigazione e tab bar scure neon
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(red: 0.05, green: 0.07, blue: 0.09, alpha: 1.0)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
    
    var body: some Scene {
        WindowGroup {
            MainTabView()
        }
    }
}

struct MainTabView: View {
    @State private var selectedTab: Int = 0
    
    @ObservedObject var store = Store.shared
    
    var body: some View {
        TabView(selection: $selectedTab) {
            TodayView()
                .tabItem {
                    Label(L10n.tabToday, systemImage: "sparkles")
                }
                .tag(0)
            
            PantryView()
                .tabItem {
                    Label(L10n.tabPantry, systemImage: "refrigerator.fill")
                }
                .tag(1)
            
            RecipeBookView(onStartCooking = { selectedTab = 0 })
                .tabItem {
                    Label(L10n.tabRecipeBook, systemImage: "book.fill")
                }
                .tag(2)
            
            DiaryView()
                .tabItem {
                    Label(L10n.tabDiary, systemImage: "calendar")
                }
                .tag(3)
            
            ProfileView()
                .tabItem {
                    Label(L10n.tabProfile, systemImage: "person.crop.circle")
                }
                .tag(4)
        }
        .tint(.jarvisNeonGreen)
    }
}
